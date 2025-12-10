import { WebhookClient, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

class BTCWalletMonitor {
  constructor() {
    this.walletAddress = process.env.BTC_WALLET_ADDRESS;
    this.webhookClient = new WebhookClient({ 
      url: process.env.DISCORD_WEBHOOK_URL_BTC || process.env.DISCORD_WEBHOOK_URL 
    });
    this.processedTxs = new Set();
    this.lastCheckedTxs = new Set();
    this.isRunning = false;
    this.apiUrl = this.getApiUrl();
    this.checkInterval = 10000; // Check every 10 seconds (Bitcoin blocks are ~10 min)
  }

  getApiUrl() {
    const network = process.env.BTC_NETWORK || 'testnet';
    if (network === 'mainnet') {
      return 'https://blockstream.info/api';
    } else if (network === 'testnet4') {
      return 'https://mempool.space/testnet4/api';
    }
    return 'https://blockstream.info/testnet/api';
  }

  getNetwork() {
    const network = process.env.BTC_NETWORK || 'testnet';
    if (network === 'mainnet') return 'Mainnet';
    if (network === 'testnet4') return 'Testnet4';
    return 'Testnet3';
  }

  async start() {
    console.log(`Starting Bitcoin wallet monitor for: ${this.walletAddress}`);
    console.log(`Network: ${this.getNetwork()}`);
    console.log('Polling for transactions every 10 seconds...');

    // Validate address format
    if (!this.isValidBitcoinAddress(this.walletAddress)) {
      console.error('Invalid Bitcoin wallet address!');
      return;
    }

    this.isRunning = true;

    // Check for recent transactions first
    await this.checkRecentTransactions();

    // Start polling for new transactions
    this.startPolling();

    console.log('✓ Bitcoin monitor is running!');
  }

  isValidBitcoinAddress(address) {
    // Basic validation for Bitcoin addresses
    const mainnetRegex = /^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/;
    const testnetRegex = /^(m|n|2|tb1)[a-zA-HJ-NP-Z0-9]{25,62}$/;
    const testnet4Regex = /^(m|n|2|tb1)[a-zA-HJ-NP-Z0-9]{25,62}$/; // Same format as testnet3
    
    return mainnetRegex.test(address) || testnetRegex.test(address) || testnet4Regex.test(address);
  }

  startPolling() {
    this.pollTransactions();
  }

  async pollTransactions() {
    if (!this.isRunning) return;

    const startTime = Date.now();

    try {
      await this.checkRecentTransactions();
    } catch (error) {
      console.error('Error polling transactions:', error.message);
    }

    // Calculate next poll time to maintain consistent interval
    const elapsed = Date.now() - startTime;
    const nextPoll = Math.max(0, this.checkInterval - elapsed);

    setTimeout(() => this.pollTransactions(), nextPoll);
  }

  async checkRecentTransactions() {
    try {
      console.log(`Checking: ${this.apiUrl}/address/${this.walletAddress}`);
      
      // Fetch both confirmed and unconfirmed (mempool) transactions
      const [confirmedResponse, mempoolResponse] = await Promise.all([
        axios.get(`${this.apiUrl}/address/${this.walletAddress}/txs`).catch(err => {
          console.log(`Confirmed txs error: ${err.response?.status || err.message}`);
          return { data: [] };
        }),
        axios.get(`${this.apiUrl}/address/${this.walletAddress}/txs/mempool`).catch(err => {
          console.log(`Mempool txs error: ${err.response?.status || err.message}`);
          return { data: [] };
        })
      ]);

      const confirmedTxs = confirmedResponse.data || [];
      const mempoolTxs = mempoolResponse.data || [];
      
      console.log(`Found ${confirmedTxs.length} confirmed, ${mempoolTxs.length} pending transactions`);
      
      // Combine both confirmed and pending transactions
      const allTransactions = [...mempoolTxs, ...confirmedTxs];

      if (allTransactions.length === 0) {
        if (this.lastCheckedTxs.size === 0) {
          console.log('No transactions found for this address yet. Waiting for transactions...');
        }
        return;
      }

      // Get current transaction IDs
      const currentTxIds = new Set(allTransactions.map(tx => tx.txid));

      // Find new transactions (not in last check)
      const newTxs = allTransactions.filter(tx => !this.lastCheckedTxs.has(tx.txid));

      if (newTxs.length > 0) {
        console.log(`💫 Found ${newTxs.length} new transaction(s)`);

        for (const tx of newTxs) {
          if (this.processedTxs.has(tx.txid)) continue;
          
          this.processedTxs.add(tx.txid);
          console.log(`Processing tx: ${tx.txid}`);
          await this.analyzeAndNotify(tx);
        }
      }

      // Update last checked transactions
      this.lastCheckedTxs = currentTxIds;

      // Clean up old processed txs (keep last 1000)
      if (this.processedTxs.size > 1000) {
        const txArray = Array.from(this.processedTxs);
        this.processedTxs = new Set(txArray.slice(-1000));
      }

    } catch (error) {
      if (error.response?.status === 404) {
        console.error('Address not found or has no transactions');
      } else {
        console.error('Error checking transactions:', error.message);
      }
    }
  }

  async processTransaction(txId) {
    try {
      if (this.processedTxs.has(txId)) return;
      
      this.processedTxs.add(txId);

      // Fetch transaction details
      const response = await axios.get(`${this.apiUrl}/tx/${txId}`);
      const tx = response.data;

      await this.analyzeAndNotify(tx);

      // Clean up old processed txs (keep last 1000)
      if (this.processedTxs.size > 1000) {
        const txArray = Array.from(this.processedTxs);
        this.processedTxs = new Set(txArray.slice(-1000));
      }

    } catch (error) {
      console.error('Error processing transaction:', error.message);
    }
  }

  async analyzeAndNotify(tx) {
    try {
      let totalReceived = 0;
      let totalSent = 0;
      let isIncoming = false;
      let isOutgoing = false;

      // Check outputs (receiving)
      for (const vout of tx.vout) {
        if (vout.scriptpubkey_address === this.walletAddress) {
          totalReceived += vout.value;
          isIncoming = true;
        }
      }

      // Check inputs (sending)
      for (const vin of tx.vin) {
        if (vin.prevout?.scriptpubkey_address === this.walletAddress) {
          totalSent += vin.prevout.value;
          isOutgoing = true;
        }
      }

      // Determine net change
      const netChange = totalReceived - totalSent;
      
      if (netChange === 0) return; // No change for this address

      const amount = Math.abs(netChange) / 100000000; // Convert satoshis to BTC
      const type = netChange > 0 ? 'incoming' : 'outgoing';
      const status = tx.status.confirmed ? 'confirmed' : 'pending';

      await this.sendDiscordNotification(
        tx.txid,
        amount,
        type === 'incoming',
        status,
        tx.status.block_height,
        tx.status.block_time
      );

    } catch (error) {
      console.error('Error analyzing transaction:', error.message);
    }
  }

  async sendDiscordNotification(txId, amount, isIncoming, status, blockHeight, blockTime) {
    try {
      // Get real-time BTC price
      const btcPriceUSD = await import('./priceService.js').then(m => m.default.getBTCPrice());
      const usdValue = (amount * btcPriceUSD).toFixed(2);
      
      const typeEmoji = isIncoming ? '📥' : '📤';
      const typeText = isIncoming ? 'Incoming' : 'Outgoing';
      const color = status === 'pending' ? 0x3498db : (isIncoming ? 0x2ecc71 : 0xe74c3c);
      
      const date = blockTime ? new Date(blockTime * 1000) : new Date();
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
      let explorerUrl;
      if (network === 'Mainnet') {
        explorerUrl = `https://blockstream.info/tx/${txId}`;
      } else if (network === 'Testnet4') {
        explorerUrl = `https://mempool.space/testnet4/tx/${txId}`;
      } else {
        explorerUrl = `https://blockstream.info/testnet/tx/${txId}`;
      }

      let description = '';
      
      if (status === 'pending') {
        // Pending transaction format
        description = `⚠️ **BTC Transaction Alert**\n\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n`;
        description += `🪙 **Asset:** Bitcoin (BTC)\n`;
        description += `🔢 **Amount:** ${amount.toFixed(8)} BTC\n`;
        description += `💵 **USD Value:** $${usdValue}\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `⏳ **Status:** Pending (Unconfirmed)\n\n`;
        description += `👉 **Action:** Wait for confirmations\n\n`;
        description += `🔗 **Transaction:** [View on Blockstream](${explorerUrl})`;
      } else {
        // Confirmed transaction format
        const title = isIncoming 
          ? `✅ **New BTC transaction of $${usdValue} received:**`
          : `📤 **BTC transaction of $${usdValue} sent:**`;
        
        description = `${title}\n\n`;
        description += `💰 **${amount.toFixed(8)} BTC** ($${usdValue})\n`;
        description += `⚡ **Status:** Confirmed\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `🔗 **Network:** Bitcoin (${network})\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n`;
        description += `📦 **Block Height:** ${blockHeight}\n\n`;
        description += `🔗 **Transaction:** [View on Blockstream](${explorerUrl})`;
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
const monitor = new BTCWalletMonitor();
monitor.start().catch(console.error);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  monitor.stop();
  process.exit(0);
});
