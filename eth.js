import { ethers } from 'ethers';
import { WebhookClient, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

class WalletMonitor {
  constructor() {
    // Use WebSocketProvider for real-time events
    const wsUrl = process.env.ETH_RPC_URL.replace('https://', 'wss://').replace('http://', 'ws://');
    this.provider = new ethers.WebSocketProvider(wsUrl);
    this.walletAddress = process.env.WALLET_ADDRESS.toLowerCase();
    this.webhookClient = new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL_ETH });
    this.processedTxs = new Set();
    this.pendingTxs = new Map(); // Track pending txs to update when confirmed
  }

  async start() {
    console.log(`Starting real-time wallet monitor for: ${this.walletAddress}`);
    console.log('Using WebSocket for instant notifications...');
    
    // Listen for pending transactions in real-time
    this.provider.on('pending', async (txHash) => {
      await this.handlePendingTx(txHash);
    });

    // Listen for new blocks to catch confirmed transactions in real-time
    this.provider.on('block', async (blockNumber) => {
      await this.handleNewBlock(blockNumber);
    });
    
    console.log('✓ Monitor is running in real-time mode!');
  }

  async handlePendingTx(txHash) {
    try {
      if (this.processedTxs.has(txHash) || this.pendingTxs.has(txHash)) return;

      const tx = await this.provider.getTransaction(txHash);
      if (!tx) return;

      const isIncoming = tx.to?.toLowerCase() === this.walletAddress;
      const isOutgoing = tx.from?.toLowerCase() === this.walletAddress;

      if (isIncoming || isOutgoing) {
        this.pendingTxs.set(txHash, { tx, isIncoming, timestamp: Date.now() });
        await this.sendDiscordNotification(tx, 'pending', isIncoming);
        console.log(`⏳ Pending ${isIncoming ? 'incoming' : 'outgoing'} tx: ${txHash}`);
      }
    } catch (error) {
      // Silently handle errors for pending txs (they may not be available yet)
      if (error.message.includes('429')) {
        console.log('⚠ Rate limit hit, slowing down...');
      }
    }
  }

  async handleNewBlock(blockNumber) {
    try {
      // Only check pending txs we're tracking - don't scan entire block
      if (this.pendingTxs.size > 0) {
        for (const [txHash, data] of this.pendingTxs.entries()) {
          try {
            const receipt = await this.provider.getTransactionReceipt(txHash);
            if (receipt && receipt.blockNumber) {
              // Transaction is confirmed
              const { isIncoming } = data;
              this.pendingTxs.delete(txHash);
              this.processedTxs.add(txHash);
              
              const tx = await this.provider.getTransaction(txHash);
              if (tx) {
                await this.sendDiscordNotification(tx, 'confirmed', isIncoming);
                console.log(`✓ Confirmed ${isIncoming ? 'incoming' : 'outgoing'} tx: ${txHash}`);
              }
            }
          } catch (error) {
            // Transaction not yet mined, continue
          }
        }
      }

      // Clean up old pending txs (older than 10 minutes)
      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      for (const [hash, data] of this.pendingTxs.entries()) {
        if (data.timestamp < tenMinutesAgo) {
          this.pendingTxs.delete(hash);
          console.log(`⚠ Dropped pending tx (timeout): ${hash}`);
        }
      }
    } catch (error) {
      if (!error.message.includes('429')) {
        console.error('Error handling new block:', error.message);
      }
    }
  }

  async sendDiscordNotification(tx, status, isIncoming) {
    try {
      const value = ethers.formatEther(tx.value || '0');
      const valueNum = parseFloat(value);
      
      // Get real-time ETH price
      const ethPriceUSD = await import('./priceService.js').then(m => m.default.getETHPrice());
      const usdValue = (valueNum * ethPriceUSD).toFixed(2);
      
      const typeEmoji = isIncoming ? '📥' : '📤';
      const typeText = isIncoming ? 'Incoming' : 'Outgoing';
      const color = status === 'pending' ? 0x3498db : (isIncoming ? 0x2ecc71 : 0xe74c3c);
      
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

      let description = '';
      
      if (status === 'pending') {
        // Pending transaction format
        description = `⚠️ **ETH Transaction Alert**\n\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n`;
        description += `🪙 **Asset:** Ethereum (ETH)\n`;
        description += `🔢 **Amount:** ${value} ETH\n`;
        description += `💵 **USD Value:** $${usdValue}\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `⏳ **Status:** Pending\n\n`;
        description += `👉 **Action:** Wait for confirmations\n\n`;
        description += `🔗 **Transaction:** [View on Etherscan](https://sepolia.etherscan.io/tx/${tx.hash})`;
      } else {
        // Confirmed transaction format
        const title = isIncoming 
          ? `✅ **New ETH transaction of $${usdValue} received:**`
          : `📤 **ETH transaction of $${usdValue} sent:**`;
        
        description = `${title}\n\n`;
        description += `💰 **${value} ETH** ($${usdValue})\n`;
        description += `⚡ **Status:** Confirmed\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `🔗 **Network:** Ethereum (ETH)\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n\n`;
        description += `📦 **Block:** ${tx.blockNumber}\n`;
        description += `🔗 **Transaction:** [View on Etherscan](https://sepolia.etherscan.io/tx/${tx.hash})`;
      }

      const embed = new EmbedBuilder()
        .setDescription(description)
        .setColor(color)
        .setTimestamp();

      await this.webhookClient.send({
        embeds: [embed]
      });

      console.log(`Sent ${status} ${typeText.toLowerCase()} transaction: ${tx.hash}`);
    } catch (error) {
      console.error('Error sending Discord notification:', error.message);
    }
  }
}

// Start the monitor
const monitor = new WalletMonitor();
monitor.start().catch(console.error);
