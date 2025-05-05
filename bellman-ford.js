const BN = require('bn.js');
const config = require('./config');
const exchanges = require('./exchanges');

/**
 * A direct scan arbitrage detector optimized specifically for SOL two-hop paths
 * This replaces the more complex Bellman-Ford implementation with a simpler,
 * more efficient direct approach for the specific SOL->TOKEN->SOL case
 */
const bellmanFord = {
    /**
     * Build a simplified exchange rate map focused only on SOL pairs
     */
    buildExchangeRateGraph: async function(payer, connection) {
        console.log("Building direct SOL-pair exchange rate map for arbitrage detection...");
        const graph = [];
        
        const solTokenIndex = 0; // Index of SOL in TOKENS array
        const solToken = config.TOKENS[solTokenIndex];
        
        // Only scan for direct SOL -> TOKEN and TOKEN -> SOL pairs
        // This is much more efficient than checking all possible token pairs
        console.log("Scanning only for SOL↔TOKEN direct pairs (optimized for two-hop arbitrage)");
        
        // For each token except SOL
        for (let tokenIndex = 0; tokenIndex < config.TOKENS.length; tokenIndex++) {
            if (tokenIndex === solTokenIndex) continue; // Skip SOL itself
            
const token = config.TOKENS[tokenIndex];
            const standardInputAmount = config.STANDARD_AMOUNT;
            
            console.log(`\nScanning ${solToken.name}↔${token.name} pair for arbitrage opportunities...`);
            
            // 1. Check SOL -> TOKEN direction
            try {
                console.log(`Checking ${solToken.name} -> ${token.name} rate...`);
                const solToTokenQuote = await exchanges.getJupiterQuote(
                    solToken.mint, 
                    token.mint, 
                    standardInputAmount,
                    connection
                );
                
                if (solToTokenQuote) {
                    const inputAmount = new BN(standardInputAmount);
                    const outputAmount = new BN(solToTokenQuote.outAmount);
                    
                    const inputValue = parseFloat(inputAmount.toString()) / Math.pow(10, solToken.decimals);
                    const outputValue = parseFloat(outputAmount.toString()) / Math.pow(10, token.decimals);
                    
                    const rate = outputValue / inputValue;
                    const dexNames = solToTokenQuote.dexNames || 'Jupiter';
                    
                    console.log(`Rate ${solToken.name} -> ${token.name}: ${rate.toFixed(6)} via [${dexNames}]`);
                    
                    graph.push({
                        from: solTokenIndex,
                        to: tokenIndex,
                        fromToken: solToken,
                        toToken: token,
                        rate: rate,
                        outAmount: solToTokenQuote.outAmount,
                        routePlan: solToTokenQuote.routePlan || [],
                        dexNames: dexNames,
                        inAmount: standardInputAmount
                    });
                }
            } catch (error) {
                console.error(`Error getting rate for ${solToken.name} -> ${token.name}:`, error.message);
            }
            
            // 2. Check TOKEN -> SOL direction
            try {
                console.log(`Checking ${token.name} -> ${solToken.name} rate...`);
                const tokenToSolQuote = await exchanges.getJupiterQuote(
                    token.mint, 
                    solToken.mint, 
                    standardInputAmount,
                    connection
                );
                
                if (tokenToSolQuote) {
                    const inputAmount = new BN(standardInputAmount);
                    const outputAmount = new BN(tokenToSolQuote.outAmount);
                    
                    const inputValue = parseFloat(inputAmount.toString()) / Math.pow(10, token.decimals);
                    const outputValue = parseFloat(outputAmount.toString()) / Math.pow(10, solToken.decimals);
                    
                    const rate = outputValue / inputValue;
                    const dexNames = tokenToSolQuote.dexNames || 'Jupiter';
                    
                    console.log(`Rate ${token.name} -> ${solToken.name}: ${rate.toFixed(6)} via [${dexNames}]`);
                    
                    graph.push({
                        from: tokenIndex,
                        to: solTokenIndex,
                        fromToken: token,
                        toToken: solToken,
                        rate: rate,
                        outAmount: tokenToSolQuote.outAmount,
                        routePlan: tokenToSolQuote.routePlan || [],
                        dexNames: dexNames,
                        inAmount: standardInputAmount
                    });
                }
            } catch (error) {
                console.error(`Error getting rate for ${token.name} -> ${solToken.name}:`, error.message);
            }
        }
        
        console.log(`\nBuilt exchange rate map with ${graph.length} edges (only SOL-related pairs)`);
        return graph;
    },
    
    /**
     * Find arbitrage opportunities using a direct scan approach
     * This is much simpler and more efficient than Bellman-Ford for the specific
     * two-hop case (SOL -> TOKEN -> SOL)
     */
    findArbitrageOpportunities: function(graph) {
        if (!graph || graph.length === 0) {
            console.log("No exchange rate data available");
            return null;
        }
        
        console.log("\nScanning for two-hop arbitrage opportunities (SOL -> TOKEN -> SOL)...");
        
        const solTokenIndex = 0; // Index of SOL in TOKENS array
        const arbitrageOpportunities = [];
        
        // For each token except SOL
        for (let tokenIndex = 0; tokenIndex < config.TOKENS.length; tokenIndex++) {
            if (tokenIndex === solTokenIndex) continue; // Skip SOL itself
            
            const token = config.TOKENS[tokenIndex];
            
            // Find SOL -> TOKEN edge
            const solToTokenEdge = graph.find(e => e.from === solTokenIndex && e.to === tokenIndex);
            if (!solToTokenEdge) {
                console.log(`No ${config.TOKENS[solTokenIndex].name} -> ${token.name} path found, skipping`);
                continue;
            }
            
            // Find TOKEN -> SOL edge
            const tokenToSolEdge = graph.find(e => e.from === tokenIndex && e.to === solTokenIndex);
            if (!tokenToSolEdge) {
                console.log(`No ${token.name} -> ${config.TOKENS[solTokenIndex].name} path found, skipping`);
                continue;
            }
            
            // Calculate round-trip rate
            const roundTripRate = solToTokenEdge.rate * tokenToSolEdge.rate;
            const profitPercentage = (roundTripRate - 1) * 100;
            
            // Create a detailed description of the arbitrage path
            const dexPath = `${solToTokenEdge.fromToken.name} -> ${solToTokenEdge.toToken.name} via [${solToTokenEdge.dexNames}] -> ${tokenToSolEdge.toToken.name} via [${tokenToSolEdge.dexNames}]`;
            
            console.log(`Found cycle: ${dexPath}`);
            console.log(`Round-trip rate: ${roundTripRate.toFixed(6)}, Profit: ${profitPercentage.toFixed(4)}%`);
            
            // Check if this opportunity exceeds our profit threshold
            if (profitPercentage >= config.MIN_PROFIT_PERCENTAGE) {
                console.log(`Profitable opportunity found!`);
                
                arbitrageOpportunities.push({
                    cycle: [solTokenIndex, tokenIndex, solTokenIndex],
                    edges: [solToTokenEdge, tokenToSolEdge],
                    profitPercentage: profitPercentage,
                    roundTripRate: roundTripRate,
                    dexPath: dexPath
                });
            } else {
                console.log(`Profit ${profitPercentage.toFixed(4)}% below threshold (${config.MIN_PROFIT_PERCENTAGE}%), ignoring`);
            }
        }
        
        // Sort by profitability
        arbitrageOpportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);
        
        if (arbitrageOpportunities.length > 0) {
            console.log(`\nFound ${arbitrageOpportunities.length} profitable two-hop arbitrage opportunities!`);
            
            // Display top 3 opportunities
            for (let i = 0; i < Math.min(3, arbitrageOpportunities.length); i++) {
                const opp = arbitrageOpportunities[i];
                console.log(`#${i+1}: ${opp.dexPath}`);
                console.log(`    Profit: ${opp.profitPercentage.toFixed(4)}% (Round-trip rate: ${opp.roundTripRate.toFixed(6)})`);
            }
            
            return arbitrageOpportunities;
        } else {
            console.log("No profitable two-hop arbitrage opportunities found");
            return null;
        }
    }
};

module.exports = bellmanFord;
