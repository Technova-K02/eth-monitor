// =========================
// CONFIG
// =========================
import dotenv from "dotenv";
import { WebSocket } from "ws";
import axios from "axios";
dotenv.config();

const ALCHEMY_WS = process.env.ALCHEMY_WS_URL;
const ALCHEMY_HTTP = process.env.ETH_RPC_URL;
const BLOCKPI_WS = process.env.BLOCKPI_WS_URL;

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL_ETH;

// Wallets to monitor (lowercase)
const WATCH_ADDRESSES = process.env.WALLET_ADDRESS
    .split(",")
    .map(a => a.trim().toLowerCase());

console.log(WATCH_ADDRESSES);

// =========================
// GLOBAL STATE
// =========================

let currentWS = null;
let providerName = ""; // "alchemy" or "blockpi"
let lastProcessedBlock = 0;
let processedTxs = new Set(); // Prevent duplicate notifications

// =========================
// TOKEN TRANSFER DETECTION
// =========================
// ERC-20 Transfer event signature: Transfer(address,address,uint256)
const TRANSFER_EVENT_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// Token metadata cache
const tokenCache = new Map();

// Common token contracts and their metadata
const KNOWN_TOKENS = {
    // Ethereum Mainnet
    '0xa0b86991c31cc0c0c0c0c0c0c0c0c0c0c0c0c0c0c': { symbol: 'USDC', decimals: 6, name: 'USD Coin' },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6, name: 'Tether USD' },
    '0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18, name: 'Dai Stablecoin' },
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8, name: 'Wrapped BTC' },
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18, name: 'Wrapped Ether' },
    // Add more as needed
};

// Fetch token metadata (symbol, decimals, name)
async function getTokenMetadata(contractAddress) {
    const address = contractAddress.toLowerCase();
    
    // Check cache first
    if (tokenCache.has(address)) {
        return tokenCache.get(address);
    }
    
    // Check known tokens
    if (KNOWN_TOKENS[address]) {
        tokenCache.set(address, KNOWN_TOKENS[address]);
        return KNOWN_TOKENS[address];
    }
    
    try {
        // Fetch from blockchain
        const [symbolResult, decimalsResult, nameResult] = await Promise.all([
            makeRpcCall('eth_call', [{
                to: contractAddress,
                data: '0x95d89b41' // symbol() function signature
            }, 'latest']),
            makeRpcCall('eth_call', [{
                to: contractAddress,
                data: '0x313ce567' // decimals() function signature
            }, 'latest']),
            makeRpcCall('eth_call', [{
                to: contractAddress,
                data: '0x06fdde03' // name() function signature
            }, 'latest'])
        ]);
        
        const { ethers } = await import('ethers');
        
        // Parse results
        let symbol = 'UNKNOWN';
        let decimals = 18;
        let name = 'Unknown Token';
        
        try {
            if (symbolResult && symbolResult !== '0x') {
                symbol = ethers.AbiCoder.defaultAbiCoder().decode(['string'], symbolResult)[0];
            }
        } catch (e) {
            // Try bytes32 format for some tokens
            try {
                symbol = ethers.parseBytes32String(symbolResult);
            } catch (e2) {
                symbol = `Token (${address.slice(0, 6)}...)`;
            }
        }
        
        try {
            if (decimalsResult && decimalsResult !== '0x') {
                decimals = parseInt(decimalsResult, 16);
            }
        } catch (e) {
            decimals = 18; // Default to 18
        }
        
        try {
            if (nameResult && nameResult !== '0x') {
                name = ethers.AbiCoder.defaultAbiCoder().decode(['string'], nameResult)[0];
            }
        } catch (e) {
            name = symbol;
        }
        
        const metadata = { symbol, decimals, name };
        tokenCache.set(address, metadata);
        return metadata;
        
    } catch (error) {
        console.log(`❌ Error fetching token metadata for ${address}: ${error.message}`);
        const fallback = { 
            symbol: `Token (${address.slice(0, 6)}...)`, 
            decimals: 18, 
            name: 'Unknown Token' 
        };
        tokenCache.set(address, fallback);
        return fallback;
    }
}

// Helper function to make RPC calls
async function makeRpcCall(method, params) {
    const payload = {
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params
    };
    
    const res = await axios.post(ALCHEMY_HTTP, payload);
    return res.data.result;
}

function parseTokenTransfer(log, watchAddresses) {
    // Check if this is a Transfer event
    if (log.topics[0] !== TRANSFER_EVENT_SIGNATURE) return null;
    if (log.topics.length < 3) return null;

    // Parse addresses from topics (remove padding)
    const fromAddress = '0x' + log.topics[1].slice(-40).toLowerCase();
    const toAddress = '0x' + log.topics[2].slice(-40).toLowerCase();
    
    // Check if our wallet is involved
    const isIncoming = watchAddresses.includes(toAddress);
    const isOutgoing = watchAddresses.includes(fromAddress);
    
    if (!isIncoming && !isOutgoing) return null;

    // Parse amount from data (uint256)
    const amount = log.data && log.data !== '0x' ? BigInt(log.data) : 0n;

    return {
        tokenContract: log.address.toLowerCase(),
        from: fromAddress,
        to: toAddress,
        amount: amount.toString(),
        isIncoming,
        isOutgoing
    };
}

// Fetch transaction receipt to get logs for token transfers
async function fetchTransactionReceipt(txHash) {
    const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getTransactionReceipt",
        params: [txHash]
    };

    try {
        const res = await axios.post(ALCHEMY_HTTP, payload);
        return res.data.result;
    } catch (error) {
        console.log(`❌ Receipt fetch error: ${error.message}`);
        return null;
    }
}

// =========================
// DISCORD NOTIFIER
// =========================
async function sendDiscordNotification(tx, isIncoming, tokenTransfer = null) {
    try {
        const { ethers } = await import('ethers');
        const { WebhookClient, EmbedBuilder } = await import('discord.js');
        
        const webhookClient = new WebhookClient({ url: DISCORD_WEBHOOK });
        
        let value, valueNum, usdValue, assetName, title, description;
        
        const typeEmoji = isIncoming ? '📥' : '📤';
        const typeText = isIncoming ? 'Incoming' : 'Outgoing';
        const color = isIncoming ? 0x2ecc71 : 0xe74c3c;

        const now = new Date();
        const timeStr = now.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        }) + ' (IST)';

        if (tokenTransfer) {
            // Token transfer notification - get proper metadata
            const tokenMetadata = await getTokenMetadata(tokenTransfer.tokenContract);
            const tokenAmount = ethers.formatUnits(tokenTransfer.amount, tokenMetadata.decimals);
            valueNum = parseFloat(tokenAmount);
            assetName = tokenMetadata.symbol;
            
            title = isIncoming
                ? `✅ **New ${assetName} transfer received:**`
                : `📤 **${assetName} transfer sent:**`;

            description = `${title}\n\n` +
                `🪙 **Amount:** ${tokenAmount} ${assetName}\n` +
                `📄 **Token:** ${tokenMetadata.name}\n` +
                `� **Conetract:** ${tokenTransfer.tokenContract}\n` +
                `⚡ **Status:** Confirmed\n` +
                `🕐 **Time:** ${timeStr}\n` +
                `� **Netwo:rk:** Ethereum (ETH)\n` +
                `${typeEmoji} **Type:** ${typeText}\n\n` +
                `📦 **Block:** ${parseInt(tx.blockNumber, 16)}\n` +
                `🔗 **Transaction:** [View on Etherscan](https://etherscan.io/tx/${tx.hash})`;
        } else {
            // Native ETH transfer notification
            value = ethers.formatEther(tx.value || '0');
            valueNum = parseFloat(value);
            
            // Get real-time ETH price
            const ethPriceUSD = await import('./priceService.js').then(m => m.default.getETHPrice());
            usdValue = (valueNum * ethPriceUSD).toFixed(2);
            assetName = 'ETH';

            title = isIncoming
                ? `✅ **New ETH transaction of $${usdValue} received:**`
                : `📤 **ETH transaction of $${usdValue} sent:**`;

            description = `${title}\n\n` +
                `💰 **${value} ETH** ($${usdValue})\n` +
                `⚡ **Status:** Confirmed\n` +
                `🕐 **Time:** ${timeStr}\n` +
                `🔗 **Network:** Ethereum (ETH)\n` +
                `${typeEmoji} **Type:** ${typeText}\n\n` +
                `📦 **Block:** ${parseInt(tx.blockNumber, 16)}\n` +
                `🔗 **Transaction:** [View on Etherscan](https://etherscan.io/tx/${tx.hash})`;
        }

        const embed = new EmbedBuilder()
            .setDescription(description)
            .setColor(color)
            .setTimestamp();

        await webhookClient.send({
            embeds: [embed]
        });

        const transferType = tokenTransfer ? 'token' : 'ETH';
        console.log(`✅ Sent confirmed ${typeText.toLowerCase()} ${transferType} transaction: ${tx.hash}`);
    } catch (err) {
        console.log("Discord send error:", err.message);
    }
}

// =========================
// BLOCK FETCHING
// =========================
async function fetchBlock(blockNumber) {
    const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: [blockNumber, true] // include full txs
    };

    const res = await axios.post(ALCHEMY_HTTP, payload);
    return res.data.result;
}

// =========================
// MAIN BLOCK PROCESSOR
// =========================
async function processBlock(hexBlockNumber) {
    const blockNumber = parseInt(hexBlockNumber, 16);

    if (blockNumber <= lastProcessedBlock) return;
    lastProcessedBlock = blockNumber;

    console.log(`🔵 New Block: ${blockNumber} (provider: ${providerName})`);

    let block;
    try {
        block = await fetchBlock(hexBlockNumber);
    } catch (err) {
        console.log("Fetch block failed:", err.message);
        return;
    }

    if (!block || !block.transactions) return;

    for (const tx of block.transactions) {
        // Skip if already processed
        if (processedTxs.has(tx.hash)) continue;

        const from = tx.from?.toLowerCase();
        const to = tx.to?.toLowerCase();

        // Check for native ETH transfers
        const isNativeIncoming = WATCH_ADDRESSES.includes(to);
        const isNativeOutgoing = WATCH_ADDRESSES.includes(from);
        const hasNativeValue = tx.value && BigInt(tx.value) > 0n;

        let foundTransaction = false;

        // Handle native ETH transfers
        if ((isNativeIncoming || isNativeOutgoing) && hasNativeValue) {
            processedTxs.add(tx.hash);
            console.log(`🎯 Found native ETH transaction: ${tx.hash}`);
            console.log(`   From: ${from} (outgoing: ${isNativeOutgoing})`);
            console.log(`   To: ${to} (incoming: ${isNativeIncoming})`);
            console.log(`   Value: ${tx.value} wei`);
            
            await sendDiscordNotification(tx, isNativeIncoming);
            foundTransaction = true;
        }

        // Check for token transfers by examining transaction receipt
        if (!foundTransaction || !hasNativeValue) {
            try {
                const receipt = await fetchTransactionReceipt(tx.hash);
                if (receipt && receipt.logs) {
                    for (const log of receipt.logs) {
                        const tokenTransfer = parseTokenTransfer(log, WATCH_ADDRESSES);
                        if (tokenTransfer) {
                            if (!processedTxs.has(tx.hash)) {
                                processedTxs.add(tx.hash);
                                console.log(`🪙 Found token transfer: ${tx.hash}`);
                                console.log(`   Token: ${tokenTransfer.tokenContract}`);
                                console.log(`   From: ${tokenTransfer.from} (outgoing: ${tokenTransfer.isOutgoing})`);
                                console.log(`   To: ${tokenTransfer.to} (incoming: ${tokenTransfer.isIncoming})`);
                                console.log(`   Amount: ${tokenTransfer.amount}`);
                                
                                await sendDiscordNotification(tx, tokenTransfer.isIncoming, tokenTransfer);
                                foundTransaction = true;
                                break; // Only notify once per transaction
                            }
                        }
                    }
                }
            } catch (error) {
                console.log(`❌ Error checking token transfers for ${tx.hash}: ${error.message}`);
            }
        }
    }

    // Clean up old processed txs (keep last 1000)
    if (processedTxs.size > 1000) {
        const txArray = Array.from(processedTxs);
        processedTxs = new Set(txArray.slice(-1000));
    }
}

// =========================
// WEBSOCKET CONNECTION
// =========================
function connectWS(url, name) {
    console.log(`🔌 Connecting WebSocket: ${name} ...`);
    providerName = name;
    currentWS = new WebSocket(url);

    currentWS.on("open", () => {
        console.log(`🟢 ${name} WS connected`);
        subscribeNewHeads();
    });

    currentWS.on("message", data => {
        try {
            const json = JSON.parse(data);
            if (json.method === "eth_subscription" && json.params?.result?.number) {
                processBlock(json.params.result.number);
            }
        } catch (err) {
            console.log("WS parse error:", err.message);
        }
    });

    currentWS.on("close", () => {
        console.log(`🔴 ${name} WS closed. Reconnecting...`);
        failoverReconnect(name);
    });

    currentWS.on("error", () => {
        console.log(`⚠️ ${name} WS error. Switching provider...`);
        failoverReconnect(name);
    });
}

// Subscribe to new block headers
function subscribeNewHeads() {
    const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_subscribe",
        params: ["newHeads"]
    };
    currentWS.send(JSON.stringify(payload));
}

// =========================
// FAILOVER LOGIC
// =========================
function failoverReconnect(failedName) {
    if (failedName === "alchemy") {
        console.log("🔁 Switching to BlockPi WS...");
        setTimeout(() => connectWS(BLOCKPI_WS, "blockpi"), 2000);
    } else {
        console.log("🔁 Switching back to Alchemy WS...");
        setTimeout(() => connectWS(ALCHEMY_WS, "alchemy"), 2000);
    }
}

// =========================
// START BOT
// =========================
function start() {
    console.log("🚀 Starting Ethereum Monitor...");
    connectWS(ALCHEMY_WS, "blockpi");
}

start();