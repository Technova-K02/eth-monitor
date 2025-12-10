import { WebhookClient, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

class LTCWalletMonitor {
  constructor() {
    this.walletAddress = process.env.LTC_WALLET_ADDRESS;
    this.webhookClient = new WebhookClient({ 
      url: process.env.DISCORD_WEBHOOK_URL_LTC || process.env.DISCORD_WEBHOOK_URL 
    });
    this.processedTxs = new Set();
    this.lastCheckedTxs = new Set();
    this.isRunning = false;
    this.apiUrl = this.getApiUrl();
    this.checkInterval = 10000; // Check every 10 seconds (Litecoin blocks are ~2.5 min)
  }

  getApiUrl() {
    const network = process.env.LTC_NETWORK || 'testnet';
    if (network === 'mainnet') {
      return 'https://litecoinspace.org/api';
    }
    return 'https://litecoinspace.org/testnet/api';
  }

  getNetwork() {
    const network = process.env.LTC_NETWORK || 'testnet';
    return network === 'mainnet' ? 'Mainnet' : 'Testnet';
  }

  async start() {
    console.log(`Starting Litecoin wallet monitor for: ${this.walletAddress}`);
    console.log(`Network: ${this.getNetwork()}`);
    console.log('Polling for transactions every 10 seconds...');

    // Validate address format
    if (!this.isValidLitecoinAddress(this.walletAddress)) {
      console.error('Invalid Litecoin wallet address!');
      return;
    }

    this.isRunning = true;

    // Check for recent transactions first
    await this.checkRecentTransactions();

    // Start polling for new transactions
    this.startPolling();

    console.log('✓ Litecoin monitor is running!');
  }

  isValidLitecoinAddress(address) {
    // Basic validation for Litecoin addresses
    const mainnetRegex = /^(L|M|ltc1)[a-zA-HJ-NP-Z0-9]{25,62}$/;
    const testnetRegex = /^(m|n|2|tltc1)[a-zA-HJ-NP-Z0-9]{25,62}$/;
    
    return mainnetRegex.test(address) || testnetRegex.test(address);
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

      const amount = Math.abs(netChange) / 100000000; // Convert from litoshis to LTC
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
      // Get real-time LTC price
      const ltcPriceUSD = await import('./priceService.js').then(m => m.default.getLTCPrice());
      const usdValue = (amount * ltcPriceUSD).toFixed(2);
      
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
      const explorerUrl = network === 'Mainnet'
        ? `https://litecoinspace.org/tx/${txId}`
        : `https://litecoinspace.org/testnet/tx/${txId}`;

      let description = '';
      
      if (status === 'pending') {
        // Pending transaction format
        description = `⚠️ **LTC Transaction Alert**\n\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n`;
        description += `🪙 **Asset:** Litecoin (LTC)\n`;
        description += `🔢 **Amount:** ${amount.toFixed(8)} LTC\n`;
        description += `💵 **USD Value:** $${usdValue}\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `⏳ **Status:** Pending (Unconfirmed)\n\n`;
        description += `👉 **Action:** Wait for confirmations\n\n`;
        description += `🔗 **Transaction:** [View on Litecoin Explorer](${explorerUrl})`;
      } else {
        // Confirmed transaction format
        const title = isIncoming 
          ? `✅ **New LTC transaction of $${usdValue} received:**`
          : `📤 **LTC transaction of $${usdValue} sent:**`;
        
        description = `${title}\n\n`;
        description += `💰 **${amount.toFixed(8)} LTC** ($${usdValue})\n`;
        description += `⚡ **Status:** Confirmed\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `🔗 **Network:** Litecoin (${network})\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n`;
        description += `📦 **Block Height:** ${blockHeight}\n\n`;
        description += `🔗 **Transaction:** [View on Litecoin Explorer](${explorerUrl})`;
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
const monitor = new LTCWalletMonitor();
monitor.start().catch(console.error);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  monitor.stop();
  process.exit(0);
});
