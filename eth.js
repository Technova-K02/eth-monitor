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

        // Get real-time ETH price
        const ethPriceUSD = await import('./priceService.js').then(m => m.default.getETHPrice());
        const usdValue = (valueNum * ethPriceUSD).toFixed(2);

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

        // Confirmed transaction format
        const title = isIncoming
            ? `✅ **New ETH transaction of ${usdValue} received:**`
            : `📤 **ETH transaction of ${usdValue} sent:**`;

        const description = `${title}\n\n` +
            `💰 **${value} ETH** (${usdValue})\n` +
            `⚡ **Status:** Confirmed\n` +
            `🕐 **Time:** ${timeStr}\n` +
            `🔗 **Network:** Ethereum (ETH)\n` +
            `${typeEmoji} **Type:** ${typeText}\n\n` +
            `📦 **Block:** ${parseInt(tx.blockNumber, 16)}\n` +
            `🔗 **Transaction:** [View on Etherscan](https://sepolia.etherscan.io/tx/${tx.hash})`;

        const embed = new EmbedBuilder()
            .setDescription(description)
            .setColor(color)
            .setTimestamp();

        await webhookClient.send({
            embeds: [embed]
        });

        console.log(`Sent confirmed ${typeText.toLowerCase()} transaction: ${tx.hash}`);
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
        console.log(`Block: ${JSON.stringify(block)}`);
    } catch (err) {
        console.log("Fetch block failed:", err.message);
        return;
    }

    if (!block || !block.transactions) return;

    for (const tx of block.transactions) {
        const from = tx.from?.toLowerCase();
        const to = tx.to?.toLowerCase();

        const isIncoming = WATCH_ADDRESSES.includes(to);
        const isOutgoing = WATCH_ADDRESSES.includes(from);
        const isInvolved = isIncoming || isOutgoing;

        if (isInvolved) {
            await sendDiscordNotification(tx, isIncoming);
        }
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