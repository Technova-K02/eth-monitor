import { ethers } from 'ethers';
import { WebhookClient, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

class BNBWalletMonitor {
  constructor() {
    // Use WebSocketProvider for real-time events
    const wsUrl = (process.env.BNB_RPC_URL || 'https://bsc-dataseed.binance.org/')
      .replace('https://', 'wss://')
      .replace('http://', 'ws://');
    
    this.provider = new ethers.WebSocketProvider(wsUrl);
    this.walletAddress = process.env.BNB_WALLET_ADDRESS.toLowerCase();
    this.webhookClient = new WebhookClient({ 
      url: process.env.DISCORD_WEBHOOK_URL_BNB || process.env.DISCORD_WEBHOOK_URL 
    });
    this.processedTxs = new Set();
    this.pendingTxs = new Map();
  }

  async start() {
    console.log(`Starting real-time BNB wallet monitor for: ${this.walletAddress}`);
    console.log('Using WebSocket for instant notifications...');
    
    // Listen for pending transactions in real-time
    this.provider.on('pending', async (txHash) => {
      await this.handlePendingTx(txHash);
    });

    // Listen for new blocks to catch confirmed transactions in real-time
    this.provider.on('block', async (blockNumber) => {
      await this.handleNewBlock(blockNumber);
    });
    
    console.log('✓ BNB monitor is running in real-time mode!');
  }

  async handlePendingTx(txHash) {
    try {
      // Check if already processed or being tracked
      if (this.processedTxs.has(txHash) || this.pendingTxs.has(txHash)) return;

      const tx = await this.provider.getTransaction(txHash);
      if (!tx) return;

      const isIncoming = tx.to?.toLowerCase() === this.walletAddress;
      const isOutgoing = tx.from?.toLowerCase() === this.walletAddress;

      if (isIncoming || isOutgoing) {
        // Mark as processed immediately to prevent duplicates
        this.pendingTxs.set(txHash, { tx, isIncoming, timestamp: Date.now(), notified: false });
        
        // Only send notification if not already notified
        const txData = this.pendingTxs.get(txHash);
        if (!txData.notified) {
          await this.sendDiscordNotification(tx, 'pending', isIncoming);
          txData.notified = true;
          console.log(`⏳ Pending ${isIncoming ? 'incoming' : 'outgoing'} tx: ${txHash}`);
        }
      }
    } catch (error) {
      // Silently handle errors for pending txs (they may not be available yet)
      if (error.message?.includes('429')) {
        console.log('⚠ Rate limit hit, slowing down...');
      }
    }
  }

  async handleNewBlock(blockNumber) {
    try {
      // Only check pending txs we're tracking - don't scan entire block
      if (this.pendingTxs.size > 0) {
        const txsToCheck = Array.from(this.pendingTxs.entries());
        
        for (const [txHash, data] of txsToCheck) {
          // Skip if already marked as processed
          if (this.processedTxs.has(txHash)) {
            this.pendingTxs.delete(txHash);
            continue;
          }

          try {
            const receipt = await this.provider.getTransactionReceipt(txHash);
            if (receipt && receipt.blockNumber) {
              // Transaction is confirmed
              const { isIncoming } = data;
              
              // Mark as processed BEFORE sending notification
              this.processedTxs.add(txHash);
              this.pendingTxs.delete(txHash);
              
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
          this.processedTxs.add(hash); // Mark as processed to prevent future duplicates
          console.log(`⚠ Dropped pending tx (timeout): ${hash}`);
        }
      }

      // Clean up old processed txs (keep last 2000)
      if (this.processedTxs.size > 2000) {
        const txArray = Array.from(this.processedTxs);
        this.processedTxs = new Set(txArray.slice(-2000));
      }
    } catch (error) {
      if (!error.message?.includes('429')) {
        console.error('Error handling new block:', error.message);
      }
    }
  }

  async sendDiscordNotification(tx, status, isIncoming) {
    try {
      // Create unique key for this notification
      const notificationKey = `${tx.hash}-${status}`;
      
      // Check if we already sent this exact notification
      if (this.processedTxs.has(notificationKey)) {
        console.log(`⚠ Skipping duplicate notification: ${notificationKey}`);
        return;
      }
      
      // Mark this notification as sent
      this.processedTxs.add(notificationKey);

      const value = ethers.formatEther(tx.value || '0');
      const valueNum = parseFloat(value);
      
      // Get real-time BNB price
      const bnbPriceUSD = await import('./priceService.js').then(m => m.default.getBNBPrice());
      const usdValue = (valueNum * bnbPriceUSD).toFixed(2);
      
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

      const network = this.getNetwork();
      const explorerUrl = network === 'Testnet'
        ? `https://testnet.bscscan.com/tx/${tx.hash}`
        : `https://bscscan.com/tx/${tx.hash}`;

      let description = '';
      
      if (status === 'pending') {
        // Pending transaction format
        description = `⚠️ **BNB Transaction Alert**\n\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n`;
        description += `🪙 **Asset:** BNB (Binance Coin)\n`;
        description += `🔢 **Amount:** ${value} BNB\n`;
        description += `💵 **USD Value:** $${usdValue}\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `⏳ **Status:** Pending\n\n`;
        description += `👉 **Action:** Wait for confirmations\n\n`;
        description += `🔗 **Transaction:** [View on BscScan](${explorerUrl})`;
      } else {
        // Confirmed transaction format
        const title = isIncoming 
          ? `✅ **New BNB transaction of $${usdValue} received:**`
          : `📤 **BNB transaction of $${usdValue} sent:**`;
        
        description = `${title}\n\n`;
        description += `💰 **${value} BNB** ($${usdValue})\n`;
        description += `⚡ **Status:** Confirmed\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `🔗 **Network:** BSC (${network})\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n\n`;
        description += `📦 **Block:** ${tx.blockNumber}\n`;
        description += `🔗 **Transaction:** [View on BscScan](${explorerUrl})`;
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

  getNetwork() {
    const url = process.env.BNB_RPC_URL || '';
    if (url.includes('testnet')) return 'Testnet';
    return 'Mainnet';
  }
}

// Start the monitor
const monitor = new BNBWalletMonitor();
monitor.start().catch(console.error);
