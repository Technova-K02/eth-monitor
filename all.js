import { spawn } from 'child_process';
import dotenv from 'dotenv';

dotenv.config();

class MultiMonitor {
  constructor() {
    this.processes = new Map();
    this.isRunning = false;
  }

  async start() {
    console.log('🚀 Starting all cryptocurrency wallet monitors...\n');

    const monitors = [
      { name: 'Ethereum', script: 'eth.js', env: 'WALLET_ADDRESS' },
      { name: 'Solana', script: 'sol.js', env: 'SOL_WALLET_ADDRESS' },
      { name: 'Tron', script: 'tron.js', env: 'TRON_WALLET_ADDRESS' },
      { name: 'BNB', script: 'bnb.js', env: 'BNB_WALLET_ADDRESS' },
      { name: 'Bitcoin', script: 'btc.js', env: 'BTC_WALLET_ADDRESS' },
      { name: 'Litecoin', script: 'ltc.js', env: 'LTC_WALLET_ADDRESS' }
    ];

    this.isRunning = true;

    for (const monitor of monitors) {
      // Check if wallet address is configured
      if (!process.env[monitor.env]) {
        console.log(`⚠️  ${monitor.name}: Skipped (no wallet address configured)`);
        continue;
      }

      try {
        const child = spawn('node', [monitor.script], {
          stdio: ['inherit', 'pipe', 'pipe'],
          env: { ...process.env }
        });

        this.processes.set(monitor.name, child);

        // Handle output
        child.stdout.on('data', (data) => {
          const output = data.toString().trim();
          if (output) {
            console.log(`[${monitor.name}] ${output}`);
          }
        });

        child.stderr.on('data', (data) => {
          const output = data.toString().trim();
          if (output) {
            console.error(`[${monitor.name}] ERROR: ${output}`);
          }
        });

        child.on('close', (code) => {
          if (this.isRunning) {
            console.log(`[${monitor.name}] Process exited with code ${code}`);
            this.processes.delete(monitor.name);
            
            // Restart if it wasn't intentionally stopped
            if (code !== 0) {
              console.log(`[${monitor.name}] Restarting in 5 seconds...`);
              setTimeout(() => {
                if (this.isRunning) {
                  this.startMonitor(monitor);
                }
              }, 5000);
            }
          }
        });

        child.on('error', (error) => {
          console.error(`[${monitor.name}] Failed to start: ${error.message}`);
        });

        console.log(`✅ ${monitor.name}: Started`);
        
        // Small delay between starting monitors
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error(`❌ ${monitor.name}: Failed to start - ${error.message}`);
      }
    }

    console.log(`\n🎯 Started ${this.processes.size} monitors successfully!`);
    console.log('📊 All monitors are running in parallel');
    console.log('🔄 Monitors will auto-restart if they crash');
    console.log('⏹️  Press Ctrl+C to stop all monitors\n');

    // Show status every 30 seconds
    this.statusInterval = setInterval(() => {
      this.showStatus();
    }, 30000);
  }

  startMonitor(monitor) {
    if (!this.isRunning) return;

    try {
      const child = spawn('node', [monitor.script], {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      this.processes.set(monitor.name, child);

      child.stdout.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          console.log(`[${monitor.name}] ${output}`);
        }
      });

      child.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          console.error(`[${monitor.name}] ERROR: ${output}`);
        }
      });

      child.on('close', (code) => {
        if (this.isRunning && code !== 0) {
          console.log(`[${monitor.name}] Restarting in 5 seconds...`);
          setTimeout(() => {
            if (this.isRunning) {
              this.startMonitor(monitor);
            }
          }, 5000);
        }
      });

      console.log(`🔄 ${monitor.name}: Restarted`);
    } catch (error) {
      console.error(`❌ ${monitor.name}: Restart failed - ${error.message}`);
    }
  }

  showStatus() {
    const running = this.processes.size;
    console.log(`\n📊 Status: ${running} monitors running`);
    for (const [name] of this.processes) {
      console.log(`   ✅ ${name}`);
    }
    console.log('');
  }

  async stop() {
    console.log('\n🛑 Stopping all monitors...');
    this.isRunning = false;

    if (this.statusInterval) {
      clearInterval(this.statusInterval);
    }

    const stopPromises = [];
    
    for (const [name, process] of this.processes) {
      console.log(`⏹️  Stopping ${name}...`);
      
      const stopPromise = new Promise((resolve) => {
        process.on('close', () => {
          console.log(`✅ ${name} stopped`);
          resolve();
        });
        
        // Try graceful shutdown first
        process.kill('SIGINT');
        
        // Force kill after 5 seconds if still running
        setTimeout(() => {
          if (!process.killed) {
            process.kill('SIGKILL');
            resolve();
          }
        }, 5000);
      });
      
      stopPromises.push(stopPromise);
    }

    await Promise.all(stopPromises);
    this.processes.clear();
    
    console.log('🏁 All monitors stopped successfully');
    process.exit(0);
  }
}

// Start the multi-monitor
const multiMonitor = new MultiMonitor();
multiMonitor.start().catch(console.error);

// Handle graceful shutdown
process.on('SIGINT', async () => {
  await multiMonitor.stop();
});

process.on('SIGTERM', async () => {
  await multiMonitor.stop();
});