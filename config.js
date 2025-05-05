const { PublicKey } = require('@solana/web3.js');

module.exports = {
  // Core configuration
  PRIVATE_KEY: "Your_private_key here",
  RPC_ENDPOINT: "https://solana-rpc.publicnode.com",
  JUPITER_API_URL: "https://quote-api.jup.ag/v6",
  
  // Token mints and program IDs
  WSOL_MINT: new PublicKey("So11111111111111111111111111111111111111112"),
  USDC_MINT: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  USDT_MINT: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
  BONK_MINT: new PublicKey("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
  TOKEN_PROGRAM_ID: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  ASSOCIATED_TOKEN_PROGRAM_ID: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  SYSVAR_INSTRUCTIONS_PUBKEY: new PublicKey("Sysvar1nstructions1111111111111111111111111"),
  
  // Kamino constants
  KAMINO_LENDING_PROGRAM_ID: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
  KAMINO_LENDING_MARKET: new PublicKey("H6rHXmXoCQvq8Ue81MqNh7ow5ysPa1dSozwW3PU1dDH6"),
  KAMINO_LENDING_MARKET_AUTHORITY: new PublicKey("Dx8iy2o46sK1DzWbEcznqSKeLbLVeu7otkibA3WohGAj"),
  KAMINO_SOL_RESERVE: new PublicKey("6gTJfuPHEg6uRAijRkMqNc9kan4sVZejKMxmvx2grT1p"),
  KAMINO_SOL_RESERVE_LIQUIDITY: new PublicKey("ywaaLvG7t1vXJo8sT3UzE8yzzZtxLM7Fmev64Jbooye"),
  KAMINO_SOL_FEE_RECEIVER: new PublicKey("EQ7hw63aBS7aPQqXsoxaaBxiwbEzaAiY9Js6tCekkqxf"),
  KAMINO_REFERRER_TOKEN_STATE: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),
  KAMINO_REFERRER_ACCOUNT: new PublicKey("EQ7hw63aBS7aPQqXsoxaaBxiwbEzaAiY9Js6tCekkqxf"),
  
  // Flash loan settings
  KAMINO_FLASHLOAN_AMOUNT: "1000000000", // 1.0 SOL
  FLASH_BORROW_RESERVE_LIQUIDITY_DISCRIMINATOR: [135, 231, 52, 167, 7, 52, 212, 193],
  FLASH_REPAY_RESERVE_LIQUIDITY_DISCRIMINATOR: [185, 117, 0, 203, 96, 245, 180, 186],
  
  // Flash loan fee settings
  KAMINO_FLASH_LOAN_FEE_PERCENTAGE: 0.0005, // 0.05% fee for Kamino flash loans
  
  // Jito Configuration
  JITO_MODE: false, // Set to true to use Jito exclusively, false for regular transactions
  VERBOSE_DEBUG: true,  // Enable more detailed debug logs 
  DEV_MODE: false,      // Enable development debug logs (will log full Jupiter responses)
  JITO_BLOCK_ENGINE_URL: "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles",
  JITO_TIP_ACCOUNT: "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY", 
  JITO_MIN_TIP: 5000, // Minimum tip amount in lamports
  JITO_TIP_PERCENTAGE: 0.07, // 7% of gross profit
  JITO_BUNDLE_TIMEOUT: 10000, // 10 seconds timeout for Jito API requests
  JITO_MAX_RETRIES: 2, // Maximum number of retries for Jito bundle submission
  MIN_PROFIT_PERCENTAGE: 0.1, // 0.1% gross profit threshold
  // Settings
  CONFIRMATION_TIMEOUT: 30,
  CHECK_INTERVAL: 5000,
  COMPUTE_UNIT_LIMIT: 400000,
  SOL_TO_USDC_SLIPPAGE_BPS: "100",
  USDC_TO_SOL_SLIPPAGE_BPS: "100",
  SAFETY_BUFFER_PERCENTAGE: 0.9995, // Very small buffer (0.05%)
  USE_SAFETY_BUFFER: true, // Enable safety buffer
  DEBUG_MODE: true,
  STANDARD_AMOUNT: "1000000000",
  MAX_CYCLE_LENGTH: 3,
  
  // REMOVED: All percentage-based profit thresholds
  
  USE_BELLMAN_FORD: true,
  
  // Error handling configuration
  MAX_RETRIES: 3,
  RETRY_DELAY_BASE: 2000,
  MIN_REQUEST_INTERVAL: 1000,
  
  // Define tokens for multi-token arbitrage
  TOKENS: [
    { mint: "So11111111111111111111111111111111111111112", name: "SOL", decimals: 9 },
    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", name: "USDC", decimals: 6 },
    { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", name: "USDT", decimals: 6 },
    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", name: "BONK", decimals: 5 }
  ]
};
