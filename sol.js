import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { WebhookClient, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

class SolanaWalletMonitor {
  constructor() {
    // Use WebSocket for real-time updates
    const rpcUrl = process.env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com';
    const wsUrl = rpcUrl.replace('https://', 'wss://').replace('http://', 'ws://');
    
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: wsUrl
    });
    
    this.walletAddress = new PublicKey(process.env.SOL_WALLET_ADDRESS);
    this.webhookClient = new WebhookClient({ url: process.env.DISCORD_WEBHOOK_URL_SOL });
    this.processedSignatures = new Set();
    this.subscriptionId = null;
  }

  async start() {
    console.log(`Starting Solana wallet monitor for: ${this.walletAddress.toString()}`);
    console.log('Using WebSocket for real-time notifications...');

    // Subscribe to account changes (real-time)
    this.subscriptionId = this.connection.onAccountChange(
      this.walletAddress,
      async (accountInfo, context) => {
        console.log('💫 Account balance changed, checking recent transactions...');
        await this.checkRecentTransactions();
      },
      'confirmed'
    );

    // Initial check to mark existing transactions as processed (no notifications)
    await this.checkRecentTransactions();

    console.log('✓ Solana monitor is running in real-time mode! (Monitoring new transactions only)');
  }

  async checkRecentTransactions() {
    try {
      const signatures = await this.connection.getSignaturesForAddress(
        this.walletAddress,
        { limit: 10 },
        'confirmed'
      );

      // If this is the first check, just mark existing transactions as processed without notifying
      if (this.processedSignatures.size === 0) {
        console.log(`Found ${signatures.length} existing transactions, marking as processed (no notifications)`);
        for (const signatureInfo of signatures) {
          this.processedSignatures.add(signatureInfo.signature);
        }
        return;
      }

      // Process only new transactions
      for (const signatureInfo of signatures) {
        if (this.processedSignatures.has(signatureInfo.signature)) continue;
        
        this.processedSignatures.add(signatureInfo.signature);
        await this.processTransaction(signatureInfo);
      }

      // Clean up old signatures (keep last 1000)
      if (this.processedSignatures.size > 1000) {
        const sigArray = Array.from(this.processedSignatures);
        this.processedSignatures = new Set(sigArray.slice(-1000));
      }
    } catch (error) {
      console.error('Error checking transactions:', error.message);
    }
  }

  async processTransaction(signatureInfo) {
    try {
      const tx = await this.connection.getParsedTransaction(
        signatureInfo.signature,
        { maxSupportedTransactionVersion: 0 }
      );

      if (!tx || !tx.meta) return;

      const walletAddress = this.walletAddress.toString();
      
      // Get pre and post balances
      const accountIndex = tx.transaction.message.accountKeys.findIndex(
        key => key.pubkey.toString() === walletAddress
      );

      if (accountIndex === -1) return;

      const preBalance = tx.meta.preBalances[accountIndex] / LAMPORTS_PER_SOL;
      const postBalance = tx.meta.postBalances[accountIndex] / LAMPORTS_PER_SOL;
      const change = postBalance - preBalance;

      if (change === 0) return; // No balance change

      const isIncoming = change > 0;
      const amount = Math.abs(change);

      // Determine sender/receiver
      let otherParty = 'Unknown';
      if (tx.transaction.message.accountKeys.length > 1) {
        const otherKey = tx.transaction.message.accountKeys.find(
          key => key.pubkey.toString() !== walletAddress
        );
        if (otherKey) otherParty = otherKey.pubkey.toString();
      }

      await this.sendDiscordNotification(
        signatureInfo.signature,
        amount,
        isIncoming,
        otherParty,
        tx.blockTime,
        tx.slot,
        signatureInfo.err ? 'failed' : 'confirmed'
      );

    } catch (error) {
      console.error('Error processing transaction:', error.message);
    }
  }

  async sendDiscordNotification(signature, amount, isIncoming, otherParty, blockTime, slot, status) {
    try {
      // Get real-time SOL price
      const solPriceUSD = await import('./priceService.js').then(m => m.default.getSOLPrice());
      const usdValue = (amount * solPriceUSD).toFixed(2);
      
      const typeEmoji = isIncoming ? '📥' : '📤';
      const typeText = isIncoming ? 'Incoming' : 'Outgoing';
      const color = status === 'failed' ? 0x95a5a6 : (isIncoming ? 0x2ecc71 : 0xe74c3c);
      
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

      const network = process.env.SOL_RPC_URL?.includes('devnet') ? 'Devnet' : 
                     process.env.SOL_RPC_URL?.includes('testnet') ? 'Testnet' : 'Mainnet';
      
      const explorerUrl = network === 'Devnet' 
        ? `https://explorer.solana.com/tx/${signature}?cluster=devnet`
        : network === 'Testnet'
        ? `https://explorer.solana.com/tx/${signature}?cluster=testnet`
        : `https://explorer.solana.com/tx/${signature}`;

      let description = '';
      
      if (status === 'failed') {
        description = `❌ **SOL Transaction Failed**\n\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n`;
        description += `🪙 **Asset:** Solana (SOL)\n`;
        description += `🔢 **Amount:** ${amount.toFixed(4)} SOL\n`;
        description += `💵 **USD Value:** $${usdValue}\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `❌ **Status:** Failed\n\n`;
        description += `🔗 **Transaction:** [View on Solana Explorer](${explorerUrl})`;
      } else {
        const title = isIncoming 
          ? `✅ **New SOL transaction of $${usdValue} received:**`
          : `📤 **SOL transaction of $${usdValue} sent:**`;
        
        description = `${title}\n\n`;
        description += `💰 **${amount.toFixed(4)} SOL** ($${usdValue})\n`;
        description += `⚡ **Status:** Confirmed\n`;
        description += `🕐 **Time:** ${timeStr}\n`;
        description += `🔗 **Network:** Solana (${network})\n`;
        description += `${typeEmoji} **Type:** ${typeText}\n`;
        description += `📦 **Slot:** ${slot}\n`;
        description += `👤 **${isIncoming ? 'From' : 'To'}:** \`${otherParty.slice(0, 8)}...${otherParty.slice(-8)}\`\n\n`;
        description += `🔗 **Transaction:** [View on Solana Explorer](${explorerUrl})`;
      }

      const embed = new EmbedBuilder()
        .setDescription(description)
        .setColor(color)
        .setTimestamp();

      await this.webhookClient.send({
        embeds: [embed]
      });

      console.log(`Sent ${status} ${typeText.toLowerCase()} transaction: ${signature.slice(0, 8)}...`);
    } catch (error) {
      console.error('Error sending Discord notification:', error.message);
    }
  }

  async stop() {
    if (this.subscriptionId !== null) {
      await this.connection.removeAccountChangeListener(this.subscriptionId);
      console.log('Monitor stopped');
    }
  }
}

// Start the monitor
const monitor = new SolanaWalletMonitor();
monitor.start().catch(console.error);

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await monitor.stop();
  process.exit(0);
});
