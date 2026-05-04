export class TradeSimulator {
  constructor(threshold = 0.1) {
    this.threshold = threshold;
    this.traderGames = [];
    this.myGames = [];
  }

  addTraderGame(game) {
    this.traderGames.push(game);
  }

  addMyGame(game) {
    this.myGames.push(game);
  }

  getStats() {
    const traderTotal = this.traderGames.reduce((sum, g) => sum + g.price, 0);
    const myTotal = this.myGames.reduce((sum, g) => sum + g.price, 0);
    const diff = myTotal - traderTotal;
    const diffPercent = traderTotal === 0 ? 0 : Math.abs(diff / traderTotal);
    return { traderTotal, myTotal, diff, diffPercent };
  }

  isFair() {
    const { diffPercent } = this.getStats();
    return diffPercent <= this.threshold;
  }

  clear() {
    this.traderGames = [];
    this.myGames = [];
  }
}