import { ethers } from 'ethers';
import { WebhookClient, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

class BNBWalletMonitor {
  constructor() {
    // Use JsonRpcProvider for HTTP requests (WebSocket not supported by public RPCs)
    this.provider = new ethers.JsonRpcProvider(process.env.BNB_RPC_URL || 'https://bsc-dataseed.binance.org/');
    this.walletAddress = process.env.BNB_WALLET_ADDRESS.toLowerCase();
    this.webhookClient = new WebhookClient({ 
      url: process.env.DISCORD_WEBHOOK_URL_BNB || process.env.DISCORD_WEBHOOK_URL 
    });
    this.processedTxs = new Set();
    this.lastCheckedBlock = 0;
    this.isRunning = false;
    this.checkInterval = 3000; // Check every 3 seconds (BSC blocks are ~3 seconds)
  }

  async start() {
    console.log(`Starting BNB wallet monitor for: ${this.walletAddress}`);
    console.log('Using polling for transaction monitoring (3-second intervals)...');
    
    // Get current block number
    try {
      this.lastCheckedBlock = await this.provider.getBlockNumber();
      console.log(`Starting from block: ${this.lastCheckedBlock}`);
    } catch (error) {
      console.error('Error getting current block:', error.message);
      return;
    }

    this.isRunning = true;
    this.startPolling();
    
    console.log('✓ BNB monitor is running!');
  }

  startPolling() {
    this.pollBlocks();
  }

  async pollBlocks() {
    if (!this.isRunning) return;

    const startTime = Date.now();

    try {
      const currentBlock = await this.provider.getBlockNumber();
      
      // Check new blocks since last check
      if (currentBlock > this.lastCheckedBlock) {
        for (let blockNum = this.lastCheckedBlock + 1; blockNum <= currentBlock; blockNum++) {
          await this.checkBlockTransactions(blockNum);
        }
        this.lastCheckedBlock = currentBlock;
      }

      // Clean up old processed txs (keep last 2000)
      if (this.processedTxs.size > 2000) {
        const txArray = Array.from(this.processedTxs);
        this.processedTxs = new Set(txArray.slice(-2000));
      }

    } catch (error) {
      console.error('Error polling blocks:', error.message);
    }

    // Calculate next poll time to maintain consistent interval
    const elapsed = Date.now() - startTime;
    const nextPoll = Math.max(0, this.checkInterval - elapsed);

    setTimeout(() => this.pollBlocks(), nextPoll);
  }

  async checkBlockTransactions(blockNumber) {
    try {
      const block = await this.provider.getBlock(blockNumber, true);
      if (!block || !block.transactions) return;

      for (const tx of block.transactions) {
        const txHash = typeof tx === 'string' ? tx : tx.hash;
        
        if (this.processedTxs.has(txHash)) continue;

        const transaction = typeof tx === 'string' 
          ? await this.provider.getTransaction(tx)
          : tx;

        if (!transaction) continue;

        const isIncoming = transaction.to?.toLowerCase() === this.walletAddress;
        const isOutgoing = transaction.from?.toLowerCase() === this.walletAddress;

        if (isIncoming || isOutgoing) {
          this.processedTxs.add(txHash);
          await this.sendDiscordNotification(transaction, 'confirmed', isIncoming);
          console.log(`✓ Confirmed ${isIncoming ? 'incoming' : 'outgoing'} tx: ${txHash}`);
        }
      }
    } catch (error) {
      console.error(`Error checking block ${blockNumber}:`, error.message);
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
