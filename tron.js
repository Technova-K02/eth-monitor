import TronWeb from 'tronweb';
import { WebhookClient, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

class TronWalletMonitor {
  constructor() {
    const rpcUrl = process.env.TRON_RPC_URL || 'https://api.trongrid.io';
    const apiKey = process.env.TRON_API_KEY || '';
    
    this.tronWeb = new TronWeb({
      fullHost: rpcUrl,
      headers: apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {}
    });
    
    this.walletAddress = process.env.TRON_WALLET_ADDRESS;
    this.webhookClient = new WebhookClient({ 
      url: process.env.DISCORD_WEBHOOK_URL_TRX || process.env.DISCORD_WEBHOOK_URL 
    });
    this.processedTxs = new Set();
    this.lastCheckedTimestamp = Date.now();
    this.checkInterval = 2000; // Check every 2 seconds for real-time monitoring
    this.isRunning = false;
    this.lastBalance = null;
  }

  async start() {
    console.log(`Starting Tron wallet monitor for: ${this.walletAddress}`);
    
    // Validate address
    if (!this.tronWeb.isAddress(this.walletAddress)) {
      console.error('Invalid Tron wallet address!');
      return;
    }

    const network = this.getNetwork();
    console.log(`Network: ${network}`);
    console.log('⚡ Real-time monitoring enabled (2-second polling)...');
    
    // Get initial balance
    try {
      this.lastBalance = await this.tronWeb.trx.getBalance(this.walletAddress);
      console.log(`Initial balance: ${this.lastBalance / 1000000} TRX`);
    } catch (error) {
      console.error('Error getting initial balance:', error.message);
    }

    // Initial check
    await this.checkTransactions();

    // Start polling
    this.isRunning = true;
    this.pollTransactions();

    console.log('✓ Tron monitor is running in real-time mode!');
  }

  getNetwork() {
    const url = process.env.TRON_RPC_URL || '';
    if (url.includes('shasta')) return 'Shasta Testnet';
    if (url.includes('nile')) return 'Nile Testnet';
    return 'Mainnet';
  }

  async pollTransactions() {
    if (!this.isRunning) return;

    const startTime = Date.now();
    
    try {
      await this.checkTransactions();
    } catch (error) {
      console.error('Error polling transactions:', error.message);
    }

    // Calculate next poll time to maintain consistent interval
    const elapsed = Date.now() - startTime;
    const nextPoll = Math.max(0, this.checkInterval - elapsed);

    setTimeout(() => this.pollTransactions(), nextPoll);
  }

  async checkTransactions() {
    try {
      // First, check if balance changed (fast check)
      const currentBalance = await this.tronWeb.trx.getBalance(this.walletAddress);
      
      if (this.lastBalance !== null && currentBalance !== this.lastBalance) {
        console.log(`💫 Balance changed: ${this.lastBalance / 1000000} → ${currentBalance / 1000000} TRX`);
      }
      
      this.lastBalance = currentBalance;

      const network = this.getNetwork();
      const baseUrl = process.env.TRON_RPC_URL || 'https://api.trongrid.io';
      
      // Get recent transactions using TronGrid API
      const response = await axios.get(`${baseUrl}/v1/accounts/${this.walletAddress}/transactions`, {
        params: {
          limit: 20,
          only_confirmed: true,
          only_to: false,
          only_from: false
        },
        headers: process.env.TRON_API_KEY ? {
          'TRON-PRO-API-KEY': process.env.TRON_API_KEY
        } : {}
      });

      if (!response.data || !response.data.data) return;

      const transactions = response.data.data;

      for (const tx of transactions) {
        const txId = tx.txID;
        
        if (this.processedTxs.has(txId)) continue;
        
        // Only process transactions newer than last check (with 30 second buffer)
        if (tx.block_timestamp < this.lastCheckedTimestamp - 30000) continue;

        this.processedTxs.add(txId);
        await this.processTransaction(tx);
      }

      // Update last checked timestamp
      if (transactions.length > 0) {
        this.lastCheckedTimestamp = Math.max(
          this.lastCheckedTimestamp,
          ...transactions.map(tx => tx.block_timestamp)
        );
      }

      // Clean up old processed txs (keep last 1000)
      if (this.processedTxs.size > 1000) {
        const txArray = Array.from(this.processedTxs);
        this.processedTxs = new Set(txArray.slice(-1000));
      }

    } catch (error) {
      if (error.response?.status === 429) {
        console.log('⚠ Rate limit hit, slowing down to 5 seconds...');
        this.checkInterval = 5000;
      } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
        console.log('⚠ Connection issue, retrying...');
      } else {
        console.error('Error checking transactions:', error.message);
      }
    }
  }

  async processTransaction(tx) {
    try {
      // Only process TRX transfers (type: TransferContract)
      const contract = tx.raw_data?.contract?.[0];
      if (!contract || contract.type !== 'TransferContract') return;

      const value = contract.parameter?.value;
      if (!value) return;

      const fromAddress = this.tronWeb.address.fromHex(value.owner_address);
      const toAddress = this.tronWeb.address.fromHex(value.to_address);
      const amount = value.amount / 1000000; // Convert from SUN to TRX

      const isIncoming = toAddress === this.walletAddress;
      const isOutgoing = fromAddress === this.walletAddress;

      if (!isIncoming && !isOutgoing) return;

      const otherParty = isIncoming ? fromAddress : toAddress;

      await this.sendDiscordNotification(
        tx.txID,
        amount,
        isIncoming,
        otherParty,
        tx.block_timestamp,
        tx.ret?.[0]?.contractRet === 'SUCCESS' ? 'confirmed' : 'failed'
      );

    } catch (error) {
      console.error('Error processing transaction:', error.message);
    }
  }

  async sendDiscordNotification(txId, amount, isIncoming, otherParty, blockTime, status) {
    try {
      // Get real-time TRX price
      const trxPriceUSD = await import('./priceService.js').then(m => m.default.getTRXPrice());
      const usdValue = (amount * trxPriceUSD).toFixed(2);
      
      const typeEmoji = isIncoming ? '📥' : '📤';
      const typeText = isIncoming ? 'Incoming' : 'Outgoing';
      const color = status === 'failed' ? 0x95a5a6 : (isIncoming ? 0x2ecc71 : 0xe74c3c);
      
      const date = new Date(blockTime);
      const timeStr = date.toLocaleString('en-IN', { 
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
      
      const explorerUrl = network.includes('Shasta')
        ? `https://shasta.tronscan.org/#/transaction/${txId}`
        : network.includes('Nile')
        ? `https://nile.tronscan.org/#/transaction/${txId}`
        : `https://tronscan.org/#/transaction/${txId}`;

      let description = '';
      
      if (status === 'failed') {
        description = `❌ **TRX Transaction Failed**\n\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n`;
        description += `🪙 **Asset:** Tron (TRX)\n`;
        description += `🔢 **Amount:** ${amount.toFixed(4)} TRX\n`;
        description += `💵 **USD Value:** $${usdValue}\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `❌ **Status:** Failed\n\n`;
        description += `🔗 **Transaction:** [View on TronScan](${explorerUrl})`;
      } else {
        const title = isIncoming 
          ? `✅ **New TRX transaction of $${usdValue} received:**`
          : `📤 **TRX transaction of $${usdValue} sent:**`;
        
        description = `${title}\n\n`;
        description += `💰 **${amount.toFixed(4)} TRX** ($${usdValue})\n`;
        description += `⚡ **Status:** Confirmed\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `🔗 **Network:** Tron (${network})\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n`;
        description += `👤 **${isIncoming ? 'From' : 'To'}:** \`${otherParty.slice(0, 7)}...${otherParty.slice(-7)}\`\n\n`;
        description += `🔗 **Transaction:** [View on TronScan](${explorerUrl})`;
      }

      const embed = new EmbedBuilder()
        .setDescription(description)
        .setColor(color)
        .setTimestamp();

      await this.webhookClient.send({
        embeds: [embed]
      });

      console.log(`Sent ${status} ${typeText.toLowerCase()} transaction: ${txId.slice(0, 8)}...`);
    } catch (error) {
      console.error('Error sending Discord notification:', error.message);
    }
  }

  stop() {
    this.isRunning = false;
    console.log('Monitor stopped');
  }
}

// Start the monitor
const monitor = new TronWalletMonitor();
monitor.start().catch(console.error);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  monitor.stop();
  process.exit(0);
});
