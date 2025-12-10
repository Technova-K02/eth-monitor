import axios from 'axios';

class PriceService {
  constructor() {
    this.cache = new Map();
    this.cacheTimeout = 60000; // Cache for 1 minute
  }

  async getPrice(coinId) {
    const now = Date.now();
    const cached = this.cache.get(coinId);
    
    // Return cached price if still valid
    if (cached && (now - cached.timestamp) < this.cacheTimeout) {
      return cached.price;
    }

    try {
      const response = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`,
        { timeout: 5000 }
      );
      
      const price = response.data[coinId]?.usd;
      if (price) {
        this.cache.set(coinId, { price, timestamp: now });
        return price;
      }
    } catch (error) {
      console.log(`Price fetch failed for ${coinId}, using cached/fallback`);
    }

    // Return cached price even if expired, or fallback
    if (cached) return cached.price;
    
    // Fallback prices if API fails
    const fallbackPrices = {
      'ethereum': 3500,
      'solana': 150,
      'tron': 0.15,
      'binancecoin': 600,
      'bitcoin': 95000,
      'litecoin': 100
    };
    
    return fallbackPrices[coinId] || 0;
  }

  async getETHPrice() {
    return await this.getPrice('ethereum');
  }

  async getSOLPrice() {
    return await this.getPrice('solana');
  }

  async getTRXPrice() {
    return await this.getPrice('tron');
  }

  async getBNBPrice() {
    return await this.getPrice('binancecoin');
  }

  async getBTCPrice() {
    return await this.getPrice('bitcoin');
  }

  async getLTCPrice() {
    return await this.getPrice('litecoin');
  }
}

// Export singleton instance
export default new PriceService();