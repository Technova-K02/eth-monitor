// =========================
// BNB WALLET MONITOR - HYBRID APPROACH
// =========================
// Strategy:
// - BlockPi WebSocket for real-time notifications (0 RU cost)
// - Ankr HTTP for block/transaction fetching (500M credits/month)
// - Optimized for BSC 3-second block times
// =========================

import dotenv from "dotenv";
import { WebSocket } from "ws";
import axios from "axios";
dotenv.config();

// =========================
// CONFIG
// =========================
const BLOCKPI_WS = process.env.BLOCKPI_WS_URL_BNB;
const ANKR_HTTP = process.env.ANKR_HTTP_URL_BNB || 'https://rpc.ankr.com/bsc';
const FALLBACK_WS = process.env.BSC_FALLOVER_WS;

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL_BNB;

// Wallets to monitor (lowercase)
const WATCH_ADDRESSES = process.env.BNB_WALLET_ADDRESS
    .split(",")
    .map(a => a.trim().toLowerCase());

console.log("📍 Monitoring BNB addresses:", WATCH_ADDRESSES);

// =========================
// GLOBAL STATE
// =========================
let currentWS = null;
let providerName = ""; // "blockpi" or "fallback"
let lastProcessedBlock = 0;
let processedTxs = new Set(); // Prevent duplicate notifications

// =========================
// DISCORD NOTIFIER
// =========================
async function sendDiscordNotification(tx, isIncoming) {
    try {
        const { ethers } = await import('ethers');
        const { WebhookClient, EmbedBuilder } = await import('discord.js');
        
        const webhookClient = new WebhookClient({ url: DISCORD_WEBHOOK });
        
        const value = ethers.formatEther(tx.value || '0');
        const valueNum = parseFloat(value);

        // Get real-time BNB price
        const bnbPriceUSD = await import('./priceService.js').then(m => m.default.getBNBPrice());
        const usdValue = (valueNum * bnbPriceUSD).toFixed(2);

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

        const network = getNetwork();
        const explorerUrl = network === 'Testnet'
            ? `https://testnet.bscscan.com/tx/${tx.hash}`
            : `https://bscscan.com/tx/${tx.hash}`;

        // Confirmed transaction format
        const title = isIncoming
            ? `✅ **New BNB transaction of ${usdValue} received:**`
            : `📤 **BNB transaction of ${usdValue} sent:**`;

        const description = `${title}\n\n` +
            `💰 **${value} BNB** (${usdValue})\n` +
            `⚡ **Status:** Confirmed\n` +
            `🕐 **Time:** ${timeStr}\n` +
            `🔗 **Network:** BSC (${network})\n` +
            `${typeEmoji} **Type:** ${typeText}\n\n` +
            `📦 **Block:** ${tx.blockNumber}\n` +
            `🔗 **Transaction:** [View on BscScan](${explorerUrl})`;

        const embed = new EmbedBuilder()
            .setDescription(description)
            .setColor(color)
            .setTimestamp();

        await webhookClient.send({
            embeds: [embed]
        });

        console.log(`✅ Sent confirmed ${typeText.toLowerCase()} transaction: ${tx.hash}`);
    } catch (err) {
        console.log("❌ Discord send error:", err.message);
    }
}

function getNetwork() {
    const url = ANKR_HTTP || '';
    if (url.includes('testnet')) return 'Testnet';
    return 'Mainnet';
}

// =========================
// BLOCK FETCHING (ANKR)
// =========================
async function fetchBlock(blockNumber) {
    const payload = {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getBlockByNumber",
        params: [blockNumber, true] // include full txs
    };

    try {
        const res = await axios.post(ANKR_HTTP, payload, {
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        return res.data.result;
    } catch (error) {
        console.log(`❌ Ankr fetch error: ${error.message}`);
        throw error;
    }
}

// =========================
// MAIN BLOCK PROCESSOR
// =========================
async function processBlock(hexBlockNumber) {
    const blockNumber = parseInt(hexBlockNumber, 16);

    if (blockNumber <= lastProcessedBlock) return;
    lastProcessedBlock = blockNumber;

    console.log(`🟡 New BSC Block: ${blockNumber} (WS: ${providerName}, HTTP: Ankr)`);

    let block;
    try {
        block = await fetchBlock(hexBlockNumber);
    } catch (err) {
        console.log(`❌ Block fetch failed for ${blockNumber}:`, err.message);
        return;
    }

    if (!block || !block.transactions) {
        console.log(`⚪ Block ${blockNumber} has no transactions`);
        return;
    }

    console.log(`🔍 Checking ${block.transactions.length} transactions in block ${blockNumber}`);

    for (const tx of block.transactions) {
        // Skip if already processed
        if (processedTxs.has(tx.hash)) continue;

        const from = tx.from?.toLowerCase();
        const to = tx.to?.toLowerCase();

        const isIncoming = WATCH_ADDRESSES.includes(to);
        const isOutgoing = WATCH_ADDRESSES.includes(from);
        const isInvolved = isIncoming || isOutgoing;

        if (isInvolved) {
            processedTxs.add(tx.hash);
            console.log(`🎯 Found wallet transaction: ${tx.hash}`);
            console.log(`   From: ${from} (outgoing: ${isOutgoing})`);
            console.log(`   To: ${to} (incoming: ${isIncoming})`);
            console.log(`   Value: ${tx.value} wei`);
            
            await sendDiscordNotification(tx, isIncoming);
        }
    }

    // Clean up old processed txs (keep last 1000)
    if (processedTxs.size > 1000) {
        const txArray = Array.from(processedTxs);
        processedTxs = new Set(txArray.slice(-1000));
    }
}

// =========================
// WEBSOCKET CONNECTION (BLOCKPI)
// =========================
function connectWS(url, name) {
    console.log(`🔌 Connecting WebSocket: ${name}...`);
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
            console.log("❌ WS parse error:", err.message);
        }
    });

    currentWS.on("close", () => {
        console.log(`🔴 ${name} WS closed. Reconnecting...`);
        failoverReconnect(name);
    });

    currentWS.on("error", (error) => {
        console.log(`⚠️ ${name} WS error: ${error.message}`);
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
    console.log("📡 Subscribed to newHeads");
}

// =========================
// FAILOVER LOGIC
// =========================
function failoverReconnect(failedName) {
    if (failedName === "blockpi") {
        if (FALLBACK_WS) {
            console.log("🔁 Switching to fallback WS...");
            setTimeout(() => connectWS(FALLBACK_WS, "fallback"), 2000);
        } else {
            console.log("🔁 Reconnecting to BlockPi WS...");
            setTimeout(() => connectWS(BLOCKPI_WS, "blockpi"), 5000);
        }
    } else {
        console.log("🔁 Switching back to BlockPi WS...");
        setTimeout(() => connectWS(BLOCKPI_WS, "blockpi"), 2000);
    }
}

// =========================
// START MONITOR
// =========================
function start() {
    console.log("🚀 Starting BNB Hybrid Monitor...");
    console.log("📡 WebSocket Provider: BlockPi (0 RU cost)");
    console.log("🌐 HTTP Provider: Ankr (500M credits/month)");
    console.log("⚡ BSC Block Time: ~3 seconds");
    
    if (!BLOCKPI_WS) {
        console.error("❌ BLOCKPI_WS_URL_BNB not configured!");
        return;
    }
    
    if (!DISCORD_WEBHOOK) {
        console.error("❌ DISCORD_WEBHOOK_URL_BNB not configured!");
        return;
    }
    
    connectWS(BLOCKPI_WS, "blockpi");
}

start();