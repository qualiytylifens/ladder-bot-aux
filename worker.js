/**
 * worker.js (CommonJS)
 * Production-safe execution worker for Railway + Supabase.
 *
 * Core job:
 *  - claim execution_jobs(status='queued') where:
 *      - claimed_by is null
 *      - run_at is null OR run_at <= now()
 *  - execute directly against Coinbase layer (no internal webhook relay)
 *
 * Critical live-close rule:
 *  - LIVE close jobs MUST NEVER write fallback/paper close ledger rows.
 *  - A live close job is only completed when execution confirms the exchange close.
 *  - If confirmation is missing, the job is retried/deadlettered with
 *    live_close_unconfirmed or live_close_pending_confirmation.
 *
 * Paper/legacy close rule:
 *  - Non-live close jobs may still use DB close-ledger fallback when enabled.
 *
 * Idempotency safety fix (FIXED_POLICY_V3_DIRECT_RESOLVER):
 *  - If direct execution already produced a trade/execution
 *    for the same intent_id, the worker treats that as already executed and completes
 *    the job instead of deadlettering a false failure.
 *  - Coinbase execution module is loaded through a safe resolver so Railway path/name
 *    mismatches are surfaced clearly in logs.
 */

const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');

const { executeTrade } = (() => {
/**
 * ============================================
 * COINBASE EXECUTION LAYER v2.7
 * Advanced Trade JWT auth (ECDSA / ES256)
 * USDC-primary product and balance handling
 * Real trades. Real money. No simulation.
 *
 * v2.7 fixes:
 * - Treat Coinbase order acceptance as success even if immediate order lookup is unavailable.
 * - Preserve BOTH brokerOrderId and clientOrderId.
 * - orderId now always returns a durable value:
 *     brokerOrderId || clientOrderId
 * - SELL path skips hard failure when broker order id is not immediately available.
 * - BUY path does the same for entry execution.
 * - Added base-balance clamp on SELL to reduce size/precision rejection risk.
 * - Added safer fallback fill fields for downstream journaling/receipts.
 *
 * v2.8 fix:
 * - LIVE SELL path now uses Coinbase balance truth instead of requested trade size.
 * ============================================
 */

const crypto = require('crypto');

const COINBASE_CONFIG = {
  baseUrl: 'https://api.coinbase.com',
  apiVersion: '2024-01-01',
  keyId: process.env.COINBASE_KEY_ID || '',
  privateKey: process.env.COINBASE_PRIVATE_KEY || '',
  host: 'api.coinbase.com'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64UrlEncode(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buffer
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function normalizePrivateKey(rawKey) {
  let key = String(rawKey || '').trim();

  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }

  key = key.replace(/\\n/g, '\n');
  return key;
}

function roundBaseSize(value, decimals = 8) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const factor = Math.pow(10, decimals);
  return Math.floor(n * factor) / factor;
}

// Correct JWT assembly
function generateJWT(method, path) {
  const keyId = String(COINBASE_CONFIG.keyId || '').trim();
  const privateKey = normalizePrivateKey(COINBASE_CONFIG.privateKey);

  if (!keyId) throw new Error('Coinbase API key id not configured');
  if (!privateKey) throw new Error('Coinbase private key not configured');

  const now = Math.floor(Date.now() / 1000);
  const uri = `${String(method || 'GET').toUpperCase()} ${COINBASE_CONFIG.host}${path}`;

  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: keyId,
    nonce: crypto.randomBytes(16).toString('hex')
  };

  const payload = {
    iss: 'cdp',
    sub: keyId,
    nbf: now,
    iat: now,
    exp: now + 120,
    uri
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  });

  const encodedSignature = base64UrlEncode(signature);
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

async function coinbaseRequest(method, path, body = null) {
  const apiKey = String(COINBASE_CONFIG.keyId || '').trim();

  if (!apiKey || !COINBASE_CONFIG.privateKey) {
    return { success: false, error: 'Coinbase API credentials not configured' };
  }

  const url = `${COINBASE_CONFIG.baseUrl}${path}`;
  const bodyString = body ? JSON.stringify(body) : '';

  try {
    console.log('Signing JWT...');
    const jwt = generateJWT(method, path);
    console.log('JWT generated successfully');
    console.log(`Coinbase: ${String(method || 'GET').toUpperCase()} ${path}`);

    const options = {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json'
      }
    };

    if (bodyString) options.body = bodyString;

    const response = await fetch(url, options);
    const text = await response.text();

    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      console.error('Coinbase API Error:', { method, path, status: response.status, data });
      return {
        success: false,
        error: data?.message || data?.error || `HTTP ${response.status}`,
        status: response.status,
        data
      };
    }

    return { success: true, status: response.status, data };
  } catch (error) {
    console.error('Coinbase Request Failed:', { method, path, error: error.message });
    return { success: false, error: error.message };
  }
}

function normalizeAccount(acc) {
  const available = parseFloat(
    acc.available_balance?.value ??
    acc.available ??
    acc.balance?.available ??
    0
  );

  const hold = parseFloat(
    acc.hold?.value ??
    acc.hold ??
    acc.balance?.hold ??
    0
  );

  return {
    id: acc.uuid || acc.id || null,
    currency: String(acc.currency || '').toUpperCase(),
    available,
    hold,
    total: available + hold
  };
}

async function getAccounts() {
  const result = await coinbaseRequest('GET', '/api/v3/brokerage/accounts');
  if (!result.success) return result;

  const rawAccounts = Array.isArray(result.data?.accounts)
    ? result.data.accounts
    : Array.isArray(result.data)
      ? result.data
      : [];

  if (!rawAccounts.length) {
    console.error('[COINBASE] Accounts payload missing or empty', result.data);
    return { success: false, error: 'coinbase_accounts_empty', data: result.data };
  }

  return rawAccounts.map(normalizeAccount);
}

async function getBalance(currency) {
  const wanted = String(currency || '').toUpperCase();
  const accounts = await getAccounts();

  if (!Array.isArray(accounts)) {
    return {
      success: false,
      error: accounts.error || 'coinbase_balance_lookup_failed',
      data: accounts.data || null
    };
  }

  const account = accounts.find((a) => a.currency === wanted);

  if (!account) {
    return {
      success: false,
      error: `coinbase_${wanted}_account_not_found`,
      data: accounts
    };
  }

  return account;
}

async function getUSDBalance() {
  const usd = await getBalance('USD');

  if (usd && usd.success === false) {
    const usdc = await getBalance('USDC');
    if (usdc && usdc.success === false) {
      return {
        success: false,
        error: 'coinbase_balance_lookup_failed',
        details: { usd_error: usd.error, usdc_error: usdc.error }
      };
    }
    return usdc;
  }

  return usd;
}

async function getSpendableUsdBalance() {
  const usdc = await getBalance('USDC');
  if (usdc && usdc.success !== false) {
    console.log('[COINBASE] Spendable quote balance selected', {
      preferred_currency: 'USDC',
      available: usdc.available,
      hold: usdc.hold,
      total: usdc.total
    });
    return usdc;
  }

  const usd = await getBalance('USD');
  if (usd && usd.success !== false) {
    console.log('[COINBASE] Spendable quote balance selected', {
      preferred_currency: 'USD',
      available: usd.available,
      hold: usd.hold,
      total: usd.total
    });
    return usd;
  }

  return {
    success: false,
    error: 'coinbase_balance_lookup_failed',
    details: { usdc_error: usdc?.error || null, usd_error: usd?.error || null }
  };
}

async function getPrice(productId) {
  const result = await coinbaseRequest('GET', `/api/v3/brokerage/products/${productId}`);

  if (result.success && result.data) {
    return {
      productId: result.data.product_id,
      price: parseFloat(result.data.price),
      bid: parseFloat(result.data.quote_min_size),
      ask: parseFloat(result.data.quote_max_size),
      volume24h: parseFloat(result.data.volume_24h)
    };
  }

  return result;
}

async function getBestBidAsk(productId) {
  const result = await coinbaseRequest('GET', `/api/v3/brokerage/best_bid_ask?product_ids=${productId}`);

  if (result.success && result.data.pricebooks?.[0]) {
    const book = result.data.pricebooks[0];
    return {
      productId: book.product_id,
      bid: parseFloat(book.bids?.[0]?.price || 0),
      ask: parseFloat(book.asks?.[0]?.price || 0),
      spread: parseFloat(book.asks?.[0]?.price || 0) - parseFloat(book.bids?.[0]?.price || 0)
    };
  }

  return result;
}

function extractBrokerOrderId(data) {
  return (
    data?.order_id ||
    data?.success_response?.order_id ||
    data?.orderId ||
    null
  );
}

async function placeMarketOrder(productId, side, amount, sizeType = 'quote') {
  const clientOrderId = `CST_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const orderConfig = { market_market_ioc: {} };

  if (side.toUpperCase() === 'BUY') {
    orderConfig.market_market_ioc.quote_size = String(amount);
  } else if (sizeType === 'base') {
    orderConfig.market_market_ioc.base_size = String(amount);
  } else {
    orderConfig.market_market_ioc.quote_size = String(amount);
  }

  const order = {
    client_order_id: clientOrderId,
    product_id: productId,
    side: side.toUpperCase(),
    order_configuration: orderConfig
  };

  console.log(`[COINBASE] Placing MARKET ${side} order`, { productId, amount, sizeType });

  const result = await coinbaseRequest('POST', '/api/v3/brokerage/orders', order);

  if (result.success) {
    const brokerOrderId = extractBrokerOrderId(result.data);
    const durableOrderId = brokerOrderId || clientOrderId;

    console.log('[COINBASE] Order placed', {
      productId,
      brokerOrderId,
      clientOrderId,
      durableOrderId
    });

    return {
      success: true,
      accepted: true,
      orderId: durableOrderId,
      brokerOrderId,
      clientOrderId,
      status: result.data?.success_response?.status || 'PENDING',
      data: result.data
    };
  }

  console.error('[COINBASE] Order failed', { productId, error: result.error, data: result.data });
  return result;
}

async function placeLimitOrder(productId, side, price, size) {
  const clientOrderId = `CST_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const order = {
    client_order_id: clientOrderId,
    product_id: productId,
    side: side.toUpperCase(),
    order_configuration: {
      limit_limit_gtc: {
        base_size: size.toString(),
        limit_price: price.toString(),
        post_only: false
      }
    }
  };

  console.log(`[COINBASE] Placing LIMIT ${side} order`, { productId, price, size });

  const result = await coinbaseRequest('POST', '/api/v3/brokerage/orders', order);

  if (result.success) {
    const brokerOrderId = extractBrokerOrderId(result.data);
    return {
      success: true,
      accepted: true,
      orderId: brokerOrderId || clientOrderId,
      brokerOrderId,
      clientOrderId,
      status: 'PENDING',
      data: result.data
    };
  }

  return result;
}

async function placeStopOrder(productId, side, stopPrice, size) {
  const clientOrderId = `CST_SL_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const order = {
    client_order_id: clientOrderId,
    product_id: productId,
    side: side.toUpperCase(),
    order_configuration: {
      stop_limit_stop_limit_gtc: {
        base_size: size.toString(),
        limit_price: (stopPrice * 0.995).toString(),
        stop_price: stopPrice.toString(),
        stop_direction:
          side.toUpperCase() === 'SELL'
            ? 'STOP_DIRECTION_STOP_DOWN'
            : 'STOP_DIRECTION_STOP_UP'
      }
    }
  };

  console.log(`[COINBASE] Placing STOP ${side} order`, { productId, stopPrice, size });

  const result = await coinbaseRequest('POST', '/api/v3/brokerage/orders', order);

  if (result.success) {
    const brokerOrderId = extractBrokerOrderId(result.data);
    return {
      success: true,
      accepted: true,
      orderId: brokerOrderId || clientOrderId,
      brokerOrderId,
      clientOrderId,
      type: 'STOP_LOSS',
      stopPrice,
      size,
      data: result.data
    };
  }

  return result;
}

async function cancelOrder(orderId) {
  const result = await coinbaseRequest('POST', '/api/v3/brokerage/orders/batch_cancel', {
    order_ids: [orderId]
  });

  if (result.success) console.log('[COINBASE] Order cancelled', { orderId });
  return result;
}

async function getOrder(orderId) {
  if (!orderId) {
    return { success: false, error: 'coinbase_order_lookup_missing_order_id' };
  }

  const normalizedOrderId = String(orderId).trim();

  if (normalizedOrderId.startsWith('CST_')) {
    console.log('[COINBASE] Skipping historical lookup for clientOrderId', normalizedOrderId);
    return {
      success: true,
      skipped: true,
      orderId: normalizedOrderId,
      brokerOrderId: null,
      clientOrderId: normalizedOrderId,
      status: 'FILLED',
      filledSize: null,
      filledValue: null,
      averagePrice: null,
      createdAt: null,
      raw: null,
      source: 'client_order_id_fallback'
    };
  }

  const result = await coinbaseRequest('GET', `/api/v3/brokerage/orders/historical/${normalizedOrderId}`);

  if (result.success && result.data.order) {
    const order = result.data.order;
    return {
      success: true,
      orderId: order.order_id,
      productId: order.product_id,
      side: order.side,
      status: order.status,
      filledSize: parseFloat(order.filled_size || 0),
      filledValue: parseFloat(order.filled_value || 0),
      averagePrice: parseFloat(order.average_filled_price || 0),
      createdAt: order.created_time,
      raw: order
    };
  }

  return result;
}

async function getOrderBestEffort(orderId, retries = 2, delayMs = 750) {
  if (!orderId) {
    return { success: false, error: 'coinbase_order_lookup_missing_order_id' };
  }

  const normalizedOrderId = String(orderId).trim();

  if (normalizedOrderId.startsWith('CST_')) {
    return {
      success: true,
      skipped: true,
      orderId: normalizedOrderId,
      brokerOrderId: null,
      clientOrderId: normalizedOrderId,
      status: 'FILLED',
      filledSize: null,
      filledValue: null,
      averagePrice: null,
      createdAt: null,
      raw: null,
      source: 'client_order_id_fallback'
    };
  }

  let last = null;
  for (let i = 0; i <= retries; i++) {
    last = await getOrder(normalizedOrderId);
    if (last?.success) return last;
    if (i < retries) await sleep(delayMs);
  }
  return last || { success: false, error: 'coinbase_order_lookup_failed' };
}

async function getOpenOrders() {
  const result = await coinbaseRequest('GET', '/api/v3/brokerage/orders/historical/batch?order_status=OPEN');

  if (result.success && result.data.orders) {
    return result.data.orders.map(order => ({
      orderId: order.order_id,
      productId: order.product_id,
      side: order.side,
      status: order.status,
      type: order.order_type,
      size: parseFloat(order.size || order.base_size || 0),
      price: parseFloat(order.price || order.limit_price || 0),
      createdAt: order.created_time
    }));
  }

  return [];
}

function normalizeSignalSide(side) {
  const s = String(side || '').trim().toLowerCase();

  if (s === 'buy' || s === 'long') return 'BUY';
  if (s === 'sell' || s === 'short') return 'SELL';
  if (s === 'close' || s === 'exit') return 'SELL';

  return s.toUpperCase();
}

function normalizeCoinbaseSymbol(symbol) {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;

  const directMap = {
    'ETHC-USDC': 'ETH-USD',
    'BTCC-USDC': 'BTC-USD',
    'DOGEC-USDC': 'DOGE-USD',
    'SOLC-USDC': 'SOL-USD',
    'XRPC-USDC': 'XRP-USD',
    'ETHCUSD': 'ETH-USD',
    'BTCCUSD': 'BTC-USD',
    'DOGECUSD': 'DOGE-USD',
    'SOLCUSD': 'SOL-USD',
    'XRPCUSD': 'XRP-USD'
  };

  if (directMap[raw]) return directMap[raw];

  if (raw.endsWith('C-USDC')) {
    const base = raw.replace('C-USDC', '');
    return `${base}-USD`;
  }

  if (raw.endsWith('-USDC')) {
    const base = raw.replace('-USDC', '');
    return `${base}-USD`;
  }

  if (raw.endsWith('USDC') && !raw.includes('-')) {
    const base = raw.replace('USDC', '');
    return `${base}-USD`;
  }

  if (raw.endsWith('-USD')) return raw;
  if (raw.endsWith('USD') && !raw.includes('-')) {
    const base = raw.replace('USD', '');
    return `${base}-USD`;
  }

  return raw;
}

function extractBaseCoin(productId) {
  return String(productId || '').split('-')[0] || null;
}

function resolveUsdSize(signal) {
  const candidates = [
    signal?.size_usd,
    signal?.amount_usd,
    signal?.usdAmount,
    signal?.size,
    signal?.amount,
    signal?.notional
  ];

  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }

  return 50;
}

function resolveBaseSize(signal) {
  const candidates = [
    signal?.base_size,
    signal?.qty_base,
    signal?.qty,
    signal?.size_base
  ];

  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }

  return null;
}

function resolveReferencePrice(signal) {
  const candidates = [
    signal?.mark_price,
    signal?.price,
    signal?.entry_price,
    signal?.avg_price
  ];

  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }

  return 0;
}

async function openPosition(productId, side, quoteAmount, stopLossPercent = 5, takeProfitPercent = 10) {
  const normalizedProductId = normalizeCoinbaseSymbol(productId);
  const baseCoin = extractBaseCoin(normalizedProductId);

  console.log(`\n[COINBASE] OPENING POSITION ${side} ${normalizedProductId} with quote ${quoteAmount}`);

  // Advisory only: do not hard-block entry on balance lookup failure.
  // Let Coinbase reject the order if funding is actually insufficient.
  const balance = await getSpendableUsdBalance().catch((err) => ({
    success: false,
    error: err?.message || String(err)
  }));

  if (balance && balance.success === false) {
    console.warn('[COINBASE] Advisory balance lookup failed, proceeding to Coinbase order placement', {
      productId: normalizedProductId,
      error: balance.error || null,
      details: balance.details || null
    });
  } else if (balance && balance.available != null) {
    console.log('[COINBASE] Spendable balance advisory', {
      selected_currency: balance.currency,
      available: balance.available,
      requested_quote_amount: quoteAmount,
      productId: normalizedProductId
    });
  }

  let entryPrice = 0;

  const priceData = await getBestBidAsk(normalizedProductId);
  if (priceData && Number(priceData.bid) > 0) {
    entryPrice = side.toUpperCase() === 'BUY'
      ? Number(priceData.ask || priceData.bid)
      : Number(priceData.bid);
  } else {
    const productData = await getPrice(normalizedProductId);
    if (productData && Number(productData.price) > 0) {
      entryPrice = Number(productData.price);
      console.warn('[COINBASE] best_bid_ask unavailable, using product price fallback', {
        productId: normalizedProductId,
        fallbackPrice: entryPrice
      });
    }
  }

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { success: false, error: `Could not get current price for ${normalizedProductId}` };
  }

  const marketOrder = await placeMarketOrder(normalizedProductId, side, quoteAmount, 'quote');
  if (!marketOrder.success) {
    return { success: false, error: `Market order failed: ${marketOrder.error}` };
  }

  let filledPrice = entryPrice;
  let filledSize = quoteAmount / Math.max(entryPrice, 0.00000001);

  if (marketOrder.brokerOrderId) {
    const orderDetails = await getOrderBestEffort(marketOrder.brokerOrderId, 2, 750);
    if (orderDetails?.success) {
      filledPrice = Number(orderDetails.averagePrice || filledPrice);
      filledSize = Number(orderDetails.filledSize || filledSize);
    } else {
      console.log('[COINBASE] BUY order accepted; details pending', {
        productId: normalizedProductId,
        orderId: marketOrder.orderId,
        brokerOrderId: marketOrder.brokerOrderId,
        clientOrderId: marketOrder.clientOrderId,
        lookup_error: orderDetails?.error || null
      });
    }
  } else {
    console.log('[COINBASE] BUY order accepted without immediate broker order id', {
      productId: normalizedProductId,
      orderId: marketOrder.orderId,
      clientOrderId: marketOrder.clientOrderId
    });
  }

  const stopLossPrice = side.toUpperCase() === 'BUY'
    ? filledPrice * (1 - stopLossPercent / 100)
    : filledPrice * (1 + stopLossPercent / 100);

  const takeProfitPrice = side.toUpperCase() === 'BUY'
    ? filledPrice * (1 + takeProfitPercent / 100)
    : filledPrice * (1 - takeProfitPercent / 100);

  const stopSide = side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
  const stopOrder = await placeStopOrder(normalizedProductId, stopSide, stopLossPrice, filledSize);
  const tpOrder = await placeLimitOrder(normalizedProductId, stopSide, takeProfitPrice, filledSize);

  return {
    success: true,
    accepted: true,
    id: `POS_${Date.now()}`,
    coin: baseCoin,
    productId: normalizedProductId,
    side: side.toUpperCase(),
    entryPrice: filledPrice,
    size: filledSize,
    usdValue: quoteAmount,
    stopLoss: { price: stopLossPrice, orderId: stopOrder.orderId, percent: stopLossPercent },
    takeProfit: { price: takeProfitPrice, orderId: tpOrder.orderId, percent: takeProfitPercent },
    status: 'OPEN',
    openedAt: new Date().toISOString(),
    orderId: marketOrder.orderId,
    brokerOrderId: marketOrder.brokerOrderId || null,
    clientOrderId: marketOrder.clientOrderId || null,
    fillQty: filledSize,
    fillPrice: filledPrice,
    exchange: 'coinbase',
    detail: marketOrder.data || null,
    orders: { entry: marketOrder, stopLoss: stopOrder, takeProfit: tpOrder }
  };
}

async function closePosition(position, reason = 'MANUAL') {
  const productId = normalizeCoinbaseSymbol(position.productId);
  const closeSide = position.side === 'BUY' ? 'SELL' : 'BUY';

  if (position.stopLoss?.orderId) await cancelOrder(position.stopLoss.orderId);
  if (position.takeProfit?.orderId) await cancelOrder(position.takeProfit.orderId);

  const closeSize = Number(position.size || 0);
  if (!Number.isFinite(closeSize) || closeSize <= 0) {
    return { success: false, error: 'Failed to close: invalid position.size for base close' };
  }

  const closeOrder = await placeMarketOrder(productId, closeSide, closeSize, 'base');
  if (!closeOrder.success) {
    return { success: false, error: `Failed to close: ${closeOrder.error}` };
  }

  let filledSize = closeSize;
  let exitPrice = 0;
  let detail = closeOrder.data || null;

  if (closeOrder.brokerOrderId) {
    const orderDetails = await getOrderBestEffort(closeOrder.brokerOrderId, 2, 750);
    if (orderDetails?.success) {
      filledSize = Number(orderDetails.filledSize || closeSize);
      exitPrice = Number(orderDetails.averagePrice || 0);
      detail = orderDetails.raw || orderDetails;
    }
  }

  const pnl = position.side === 'BUY'
    ? (exitPrice - position.entryPrice) * filledSize
    : (position.entryPrice - exitPrice) * filledSize;

  const pnlPercent = position.usdValue > 0 ? (pnl / position.usdValue) * 100 : 0;

  return {
    success: true,
    accepted: true,
    position,
    orderId: closeOrder.orderId,
    brokerOrderId: closeOrder.brokerOrderId || null,
    clientOrderId: closeOrder.clientOrderId || null,
    fillQty: filledSize,
    fillPrice: exitPrice,
    exchange: 'coinbase',
    detail,
    exitPrice,
    pnl,
    pnlPercent,
    reason,
    closedAt: new Date().toISOString()
  };
}

async function executeTrade(signal) {
  try {
    console.log('[COINBASE EXECUTOR] Received signal', signal);

    if (!signal || !signal.symbol || !signal.side) {
      return { success: false, error: 'executeTrade_missing_signal_fields' };
    }

    const side = normalizeSignalSide(signal.side);
    const productId = normalizeCoinbaseSymbol(signal.symbol);

    if (!productId) {
      return { success: false, error: 'executeTrade_invalid_product_mapping' };
    }

    if (side === 'BUY') {
      const quoteAmount = resolveUsdSize(signal);
      return await openPosition(productId, side, quoteAmount);
    }

    if (side === 'SELL') {
      const baseCurrency = extractBaseCoin(productId);
      const baseBalance = await getBalance(baseCurrency);

      if (baseBalance?.success === false) {
        return {
          success: false,
          error: `SELL rejected: failed to fetch ${baseCurrency} balance (${baseBalance.error || 'unknown'})`
        };
      }

      const availableBaseRaw = Number(baseBalance.available || 0);

      if (!Number.isFinite(availableBaseRaw) || availableBaseRaw <= 0) {
        return {
          success: false,
          error: `SELL rejected: no available ${baseCurrency} balance`
        };
      }

      const sellSize = roundBaseSize(availableBaseRaw * 0.999, 8);

      if (!Number.isFinite(sellSize) || sellSize <= 0) {
        return {
          success: false,
          error: `SELL rejected: computed sell size invalid`
        };
      }

      console.log('[COINBASE EXECUTOR] SELL using BALANCE TRUTH', {
        productId,
        availableBaseRaw,
        sellSize
      });

      const sellOrder = await placeMarketOrder(productId, 'SELL', sellSize, 'base');
      if (!sellOrder.success) {
        return sellOrder;
      }

      let fillQty = sellSize;
      let fillPrice = resolveReferencePrice(signal);
      let detail = sellOrder.data || null;
      let pendingFill = true;

      if (sellOrder.brokerOrderId) {
        const orderDetails = await getOrderBestEffort(sellOrder.brokerOrderId, 2, 750);
        if (orderDetails?.success) {
          fillQty = Number(orderDetails.filledSize || sellSize);
          fillPrice = Number(orderDetails.averagePrice || fillPrice || 0);
          detail = orderDetails.raw || orderDetails;
          pendingFill = false;
        } else {
          console.log('[COINBASE EXECUTOR] SELL accepted; order details pending', {
            productId,
            orderId: sellOrder.orderId,
            brokerOrderId: sellOrder.brokerOrderId,
            clientOrderId: sellOrder.clientOrderId,
            lookup_error: orderDetails?.error || null
          });
        }
      } else {
        console.log('[COINBASE EXECUTOR] SELL accepted without immediate broker order id', {
          productId,
          orderId: sellOrder.orderId,
          clientOrderId: sellOrder.clientOrderId
        });
      }

      return {
        success: true,
        accepted: true,
        pendingFill,
        orderId: sellOrder.orderId,
        brokerOrderId: sellOrder.brokerOrderId || null,
        clientOrderId: sellOrder.clientOrderId || null,
        fillQty,
        fillPrice,
        exchange: 'coinbase',
        detail
      };
    }

    return { success: false, error: `executeTrade_unsupported_side_${side}` };
  } catch (error) {
    console.error('[COINBASE EXECUTOR] executeTrade failed', error);
    return { success: false, error: error?.message || 'executeTrade_unknown_error' };
  }
}

function toProductId(coin) {
  return `${String(coin || '').toUpperCase()}-USDC`;
}

function calculatePositionSize(accountBalance, riskPercent, entryPrice, stopLossPrice) {
  const riskAmount = accountBalance * (riskPercent / 100);
  const priceDiff = Math.abs(entryPrice - stopLossPrice);
  const riskPerUnit = priceDiff;

  if (riskPerUnit === 0) return 0;

  const positionSize = riskAmount / riskPerUnit;
  const positionValue = positionSize * entryPrice;

  return { size: positionSize, value: positionValue, riskAmount, riskPercent };
}



  return { executeTrade };
})();

function nowIso() {
  return new Date().toISOString();
}
function log(obj) {
  console.log(JSON.stringify(obj));
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function envBool(name, fallback = false) {
  const v = process.env[name];
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
function envInt(name, fallback) {
  const n = parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}
function safeTrim(v) {
  return String(v || '').trim();
}
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function msBackoff(baseMs, attempts) {
  const n = Math.max(1, Number(attempts || 0) + 1);
  return baseMs * n;
}
function parseTypes(raw) {
  if (!raw) return ['execute_intent'];
  const s = String(raw).trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr.length) return arr.map(String);
    } catch (_) {}
  }
  return s.split(/[\s,]+/g).map((x) => x.trim()).filter(Boolean);
}
function normalizePairFromSymbol(s) {
  const sym = safeTrim(s);
  if (!sym) return null;
  return sym.includes('-') ? sym.toUpperCase() : `${sym.toUpperCase()}-USDC`;
}
function normalizePolicySymbol(payload, intent) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const i = intent && typeof intent === 'object' ? intent : {};
  const raw = i.raw_signal && typeof i.raw_signal === 'object' ? i.raw_signal : {};

  const symbol =
    safeTrim(p.symbol) ||
    safeTrim(p.pair) ||
    safeTrim(raw.symbol) ||
    safeTrim(raw.pair) ||
    safeTrim(i.symbol);

  if (!symbol) return null;
  return symbol.includes('-') ? symbol.toUpperCase() : `${symbol.toUpperCase()}-USDC`;
}
function normalizeIntentSide(action) {
  const a = safeTrim(action).toLowerCase();
  if (a === 'buy') return 'LONG';
  if (a === 'sell' || a === 'close' || a === 'exit') return 'SHORT';
  return 'UNKNOWN';
}
function isExitAction(action) {
  const a = String(action || '').trim().toLowerCase();
  return a === 'close' || a === 'exit' || a === 'sell';
}
function isPaperLikeMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  return m === '' || m === 'paper' || m === 'paper_real_price';
}
function isLiveLikeMode(mode) {
  return String(mode || '').trim().toLowerCase() === 'live';
}
function summarizeUnknownError(err) {
  return {
    error_message: err && err.message ? err.message : String(err),
    error_name: err && err.name ? err.name : null,
    error_code: err && err.code ? err.code : null,
    error_details: err && err.details ? err.details : null,
    error_hint: err && err.hint ? err.hint : null,
    error_stack: err && err.stack ? err.stack : null,
  };
}

function getLiveCloseConfirmationState(result, claimed) {
  const payload = claimed && claimed.payload ? claimed.payload : {};
  const action = safeTrim(payload.action);
  const execMode = safeTrim(payload.execution_mode || payload.mode);
  const response = result && result.response ? result.response : {};
  const liveClose = isExitAction(action) && isLiveLikeMode(execMode);

  if (!liveClose) return { liveClose: false, confirmed: true, code: 'not_live_close' };

  const closeValidation = safeTrim(
    response.close_validation ||
    response.closeValidation ||
    response.validation ||
    response.data?.close_validation ||
    response.data?.closeValidation
  ).toLowerCase();

  const confirmedOrderId = safeTrim(
    response.confirmed_order_id ||
    response.confirmedOrderId ||
    response.order_id ||
    response.orderId ||
    response.data?.confirmed_order_id ||
    response.data?.confirmedOrderId ||
    response.data?.order_id ||
    response.data?.orderId
  );

  const pendingConfirmation =
    response.pending_confirmation === true ||
    response.pendingConfirmation === true ||
    response.pending === true ||
    response.awaiting_confirmation === true;

  const flatConfirmed =
    response.flat_confirmed === true ||
    response.coinbase_flat_confirmed === true ||
    response.data?.flat_confirmed === true ||
    response.data?.coinbase_flat_confirmed === true;

  const brokerConfirmed = closeValidation === 'broker_order_confirmed';
  const coinbaseFlatConfirmed = closeValidation === 'coinbase_flat_confirmed' || flatConfirmed;
  const confirmed =
    brokerConfirmed ||
    coinbaseFlatConfirmed ||
    (confirmedOrderId && !/^CST_/i.test(confirmedOrderId));

  if (confirmed) {
    return {
      liveClose: true,
      confirmed: true,
      code: brokerConfirmed ? 'broker_order_confirmed' : 'coinbase_flat_confirmed',
      closeValidation: closeValidation || null,
      confirmedOrderId: confirmedOrderId || null,
    };
  }
  if (pendingConfirmation) {
    return {
      liveClose: true,
      confirmed: false,
      code: 'live_close_pending_confirmation',
      closeValidation: closeValidation || null,
      confirmedOrderId: null,
    };
  }
  return {
    liveClose: true,
    confirmed: false,
    code: 'live_close_unconfirmed',
    closeValidation: closeValidation || null,
    confirmedOrderId: null,
  };
}

function isLiveCloseJob(job) {
  const payload = job && job.payload && typeof job.payload === 'object' ? job.payload : {};
  const action = String(payload.action || '').trim().toLowerCase();
  const raw = payload.raw_signal && typeof payload.raw_signal === 'object' ? payload.raw_signal : {};
  const executionMode = String(
    payload.execution_mode || payload.mode || raw.execution_mode || raw.mode || ''
  ).trim().toLowerCase();

  const closeLike =
    action === 'close' ||
    action === 'exit' ||
    (action === 'sell' && (
      raw._is_close_intent === true ||
      String(raw.intent_kind || '').trim().toLowerCase() === 'close_trade' ||
      !!(payload.trade_id || raw.trade_id)
    ));

  return executionMode === 'live' && closeLike;
}

// ---------- config ----------
const TAG = 'AUX';
const WORKER_ENABLED = envBool('WORKER_ENABLED', true);
const WORKER_ID = process.env.WORKER_ID || 'ladder-worker-1';
const TYPES = parseTypes(process.env.TYPES || process.env.WORKER_TYPES || 'execute_intent');
const POLL_MS = envInt('POLL_MS', 2000);
const JOB_HEARTBEAT_MS = envInt('JOB_HEARTBEAT_MS', 15000);
const MAX_ATTEMPTS = envInt('MAX_ATTEMPTS', 3);
const RETRY_BACKOFF_MS = envInt('RETRY_BACKOFF_MS', 5000);
const SELFHEAL_DEADLETTER = envBool('SELFHEAL_DEADLETTER', true);
const SELFHEAL_BATCH = envInt('SELFHEAL_BATCH', 25);
const CLOSE_LEDGER_ENABLED = envBool('CLOSE_LEDGER_ENABLED', true);
const CLOSE_LEDGER_ASSUME_BOT_WRITES = envBool('CLOSE_LEDGER_ASSUME_BOT_WRITES', false);

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const hasSupabase = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);

log({ tag: TAG, msg: 'WORKER_VERSION_CHECK', ts: nowIso(), version: 'FIXED_POLICY_V3_DIRECT_RESOLVER' });

log({
  tag: TAG,
  msg: 'WORKER_STARTED',
  ts: nowIso(),
  WORKER_ENABLED,
  WORKER_ID,
  TYPES,
  POLL_MS,
  JOB_HEARTBEAT_MS,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
  SELFHEAL_DEADLETTER,
  SELFHEAL_BATCH,
  CLOSE_LEDGER_ENABLED,
  CLOSE_LEDGER_ASSUME_BOT_WRITES,
  hasSupabase,
  direct_execution: true,
});

if (!WORKER_ENABLED) {
  log({ tag: TAG, msg: 'WORKER_DISABLED_BY_ENV', ts: nowIso() });
  setTimeout(() => process.exit(0), 250);
  return;
}
if (!hasSupabase) {
  log({
    tag: TAG,
    msg: 'FATAL_MISSING_SUPABASE_ENV',
    ts: nowIso(),
    need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'],
  });
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- lifecycle ----------
async function touchHeartbeat(jobId, step = 'processing') {
  const { error } = await sb
    .from('execution_jobs')
    .update({ heartbeat_at: nowIso(), last_step: step })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID)
    .eq('status', 'running');
  if (error) throw error;
}
function startHeartbeat(jobId, intervalMs = JOB_HEARTBEAT_MS) {
  const timer = setInterval(() => {
    touchHeartbeat(jobId, 'processing').catch((err) => {
      log({
        tag: TAG,
        msg: 'HEARTBEAT_ERROR',
        ts: nowIso(),
        job_id: jobId,
        error: String(err && err.message ? err.message : err),
      });
    });
  }, intervalMs);
  return () => clearInterval(timer);
}
async function completeJob(jobId) {
  const now = nowIso();
  const { error } = await sb
    .from('execution_jobs')
    .update({ status: 'completed', heartbeat_at: now, last_step: 'completed' })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID);
  if (error) throw error;
}
async function cancelJobSkipped(jobId, step, note) {
  const now = nowIso();
  const { error } = await sb
    .from('execution_jobs')
    .update({
      status: 'cancelled',
      heartbeat_at: now,
      last_step: step || 'policy_cancelled',
      last_error: note || null,
    })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID);
  if (error) throw error;
}
async function markFailedDeadletter(jobId, lastErrorCode) {
  const now = nowIso();
  const { error } = await sb
    .from('execution_jobs')
    .update({
      status: 'failed',
      heartbeat_at: now,
      last_step: 'failed_deadletter',
      last_error: lastErrorCode || 'deadletter_max_attempts',
    })
    .eq('id', jobId)
    .eq('claimed_by', WORKER_ID);
  if (error) throw error;
}
async function requeueWithBackoff(job, lastErrorCode) {
  const now = new Date();
  const backoffMs = msBackoff(RETRY_BACKOFF_MS, job.attempts);
  const nextRunAt = new Date(now.getTime() + backoffMs).toISOString();
  const nextAttempts = Number(job.attempts || 0) + 1;
  const { error } = await sb
    .from('execution_jobs')
    .update({
      status: 'queued',
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: now.toISOString(),
      last_step: `retry_queued_${nextAttempts}`,
      last_error: lastErrorCode || 'retry',
      attempts: nextAttempts,
      run_at: nextRunAt,
    })
    .eq('id', job.id)
    .eq('claimed_by', WORKER_ID);
  if (error) throw error;
  log({
    tag: TAG,
    msg: 'JOB_REQUEUED',
    ts: nowIso(),
    id: job.id,
    attempt: nextAttempts,
    next_run_at: nextRunAt,
    last_error: lastErrorCode,
  });
}

// ---------- job ops ----------
async function pickQueuedJob(types) {
  const now = nowIso();
  const { data, error } = await sb
    .from('execution_jobs')
    .select('id,type,status,payload,attempts,created_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id')
    .in('type', types)
    .eq('status', 'queued')
    .is('claimed_by', null)
    .or(`run_at.is.null,run_at.lte.${now}`)
    .order('run_at', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function claimJob(jobId) {
  const now = nowIso();
  const { data, error } = await sb
    .from('execution_jobs')
    .update({
      status: 'running',
      claimed_by: WORKER_ID,
      claimed_at: now,
      heartbeat_at: now,
      last_step: 'claimed',
      last_error: null,
    })
    .eq('id', jobId)
    .eq('status', 'queued')
    .is('claimed_by', null)
    .or(`run_at.is.null,run_at.lte.${now}`)
    .select('id,type,status,payload,attempts,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id')
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}

// ---------- direct execution ----------
async function executeDirect(job) {
  try {
    const payload = job && job.payload && typeof job.payload === 'object' ? job.payload : {};
    const raw = payload.raw_signal && typeof payload.raw_signal === 'object' ? payload.raw_signal : {};

    const action = String(payload.action || raw.action || '').trim().toUpperCase();
    const symbol = String(payload.symbol || payload.pair || raw.symbol || raw.pair || '').trim().toUpperCase();

    if (!action) {
      return { ok: false, code: 'missing_action', detail: 'job payload missing action' };
    }
    if (!symbol) {
      return { ok: false, code: 'missing_symbol', detail: 'job payload missing symbol' };
    }

    let signalSide = action;
    if (action === 'CLOSE' || action === 'EXIT') {
      signalSide = 'SELL';
    }

    const signal = {
      symbol,
      side: signalSide,
      price: payload.price ?? raw.price ?? raw.mark_price ?? raw.entry_price ?? null,
      amount: payload.amount ?? raw.amount ?? raw._computed_amount_usd ?? raw.amount_usd ?? 50,
      qty_base: payload.qty_base ?? raw.qty_base ?? raw._computed_qty ?? null,
      mode: payload.execution_mode || payload.mode || raw.execution_mode || raw.mode || 'live',
      trade_id: payload.trade_id || raw.trade_id || null,
      reason: payload.reason || raw.reason || raw.exit_reason || null
    };

    const exec = await executeTrade(signal);

    if (!exec || exec.success !== true) {
      return {
        ok: false,
        code: exec?.error || 'direct_execution_failed',
        detail: JSON.stringify(exec || {}).slice(0, 500),
        response: exec || null
      };
    }

    return {
      ok: true,
      code: 'ok',
      http_status: 200,
      response: {
        ok: true,
        mode: 'live',
        action: signalSide,
        order_id: exec.orderId || null,
        broker_order_id: exec.brokerOrderId || null,
        client_order_id: exec.clientOrderId || null,
        fill_qty: exec.fillQty ?? null,
        fill_price: exec.fillPrice ?? exec.entryPrice ?? exec.exitPrice ?? null,
        exchange: exec.exchange || 'coinbase',
        pending_confirmation: exec.pendingFill === true,
        close_validation:
          signalSide === 'SELL'
            ? (exec.pendingFill === true ? 'client_order_only_fill_recorded' : 'broker_order_confirmed')
            : null,
        detail: exec.detail || null
      },
      detail: JSON.stringify(exec || {}).slice(0, 500)
    };
  } catch (err) {
    return {
      ok: false,
      code: 'direct_execution_exception',
      detail: err?.message || String(err)
    };
  }
}

// ---------- policy ----------
async function fetchIntent(intentId) {
  if (!intentId) return null;
  const { data, error } = await sb
    .from('execution_intents')
    .select('id,raw_signal,action,symbol,execution_mode')
    .eq('id', intentId)
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function fetchAlphaDecisionPolicy(symbol) {
  const { data, error } = await sb
    .from('alpha_decision_policy_v2')
    .select('*')
    .eq('symbol', symbol)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}
async function policyPreflight(job) {
  const payload = job && job.payload ? job.payload : {};
  const intent = await fetchIntent(job.intent_id).catch(() => null);
  const action = safeTrim(payload.action || intent?.action).toLowerCase();
  const mode = safeTrim(payload.execution_mode || intent?.execution_mode || payload.mode || 'paper').toLowerCase();

  if (!action) return { allow: false, code: 'missing_action', symbol: null, policy: null };
  if (isExitAction(action)) {
    return { allow: true, code: 'exit_bypass', symbol: normalizePolicySymbol(payload, intent), policy: null };
  }
  if (mode !== 'live') {
    return { allow: true, code: 'paper_bypass', symbol: normalizePolicySymbol(payload, intent), policy: null };
  }

  const symbol = normalizePolicySymbol(payload, intent);
  if (!symbol) return { allow: false, code: 'missing_symbol', symbol: null, policy: null };

  try {
    const policy = await fetchAlphaDecisionPolicy(symbol);
    if (!policy) return { allow: true, code: 'no_policy_row', symbol, policy: null };

    const side = normalizeIntentSide(action);
    const sizeTier = safeTrim(policy.size_tier || '').toUpperCase();
    const sidePermission = safeTrim(policy.side_permission || '').toUpperCase();

    if (sizeTier === 'TIER_0' || sidePermission === 'FLAT_ONLY') {
      return { allow: false, code: 'flat_only', symbol, policy };
    }
    if (side === 'LONG' && sidePermission.includes('SHORT')) {
      return { allow: false, code: 'wrong_side', symbol, policy };
    }
    if (side === 'SHORT' && sidePermission.includes('LONG')) {
      return { allow: false, code: 'wrong_side', symbol, policy };
    }
    return { allow: true, code: 'policy_allow', symbol, policy };
  } catch (err) {
    log({ tag: TAG, msg: 'POLICY_PREFLIGHT_ERROR', ts: nowIso(), symbol, ...summarizeUnknownError(err) });
    return { allow: true, code: 'policy_lookup_failed_allow', symbol, policy: null };
  }
}

// ---------- idempotency helpers ----------
async function findTradeForIntent(intentId) {
  if (!intentId) return null;
  const { data, error } = await sb
    .from('trades_prod')
    .select('id,status,signal_id,symbol,created_at,closed_at,metadata,close_validation,close_order_id')
    .eq('signal_id', intentId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function findExecutionForIntent(intentId) {
  if (!intentId) return null;
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('id,trade_id,intent_id,execution_type,executed_at,created_at')
    .eq('intent_id', intentId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function detectAlreadyExecutedForIntent(intentId) {
  const trade = await findTradeForIntent(intentId).catch(() => null);
  if (trade) return { alreadyExecuted: true, source: 'trades_prod', trade };
  const execution = await findExecutionForIntent(intentId).catch(() => null);
  if (execution) return { alreadyExecuted: true, source: 'trade_executions_prod', execution };
  return { alreadyExecuted: false, source: null };
}

// ---------- close ledger helpers ----------
async function closeAlreadyWrittenForIntent(intentId) {
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('id')
    .eq('intent_id', intentId)
    .eq('execution_type', 'close')
    .limit(1);
  if (error) throw error;
  return Boolean(data && data[0]);
}
async function fetchOpenTradeById(tradeId) {
  if (!tradeId) return null;
  const { data, error } = await sb
    .from('trades_prod')
    .select('id,status,amount,qty_base,entry_price,metadata,created_at,symbol')
    .eq('id', tradeId)
    .limit(1);
  if (error) throw error;
  return data && data[0] ? data[0] : null;
}
async function findOpenPaperTradeByPair(pair) {
  const pr = safeTrim(pair);
  if (!pr) return null;
  const { data, error } = await sb
    .from('trades_prod')
    .select('id,status,amount,qty_base,entry_price,metadata,created_at,symbol')
    .eq('status', 'open')
    .eq('symbol', pr)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  for (const row of data || []) {
    const mode = row?.metadata?.mode ? String(row.metadata.mode) : null;
    if (!isPaperLikeMode(mode)) continue;
    return row;
  }
  return null;
}
async function hasAnyFill(tradeId) {
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('id')
    .eq('trade_id', tradeId)
    .in('execution_type', ['fill', 'partial_fill'])
    .limit(1);
  if (error) throw error;
  return Boolean(data && data[0]);
}
async function getTradeAmount(tradeId, tradeRow) {
  const amt = toNum(tradeRow?.amount);
  if (amt && amt > 0) return amt;
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('amount')
    .eq('trade_id', tradeId)
    .eq('execution_type', 'fill');
  if (error) throw error;
  const sum = (data || []).reduce((acc, row) => acc + (toNum(row.amount) || 0), 0);
  return sum > 0 ? sum : 50;
}
async function getTradeQtyBase(tradeId, tradeRow) {
  const q = toNum(tradeRow?.qty_base);
  if (q && q > 0) return q;
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('qty_base')
    .eq('trade_id', tradeId)
    .eq('execution_type', 'fill');
  if (error) throw error;
  const sum = (data || []).reduce((acc, row) => acc + (toNum(row.qty_base) || 0), 0);
  return sum > 0 ? sum : null;
}
async function getPriceFromMarketMarks(pair) {
  const { data, error } = await sb
    .from('market_marks')
    .select('price,marked_at')
    .eq('symbol', pair)
    .order('marked_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? toNum(data[0].price) : null;
}
async function getLastFillPrice(tradeId) {
  const { data, error } = await sb
    .from('trade_executions_prod')
    .select('price,executed_at')
    .eq('trade_id', tradeId)
    .eq('execution_type', 'fill')
    .order('executed_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0] ? toNum(data[0].price) : null;
}
async function writeCloseLedgerRow({ job, intentId, tradeId, pair, amount, qtyBase, price, priceSource, mode }) {
  const execId = randomUUID();
  const row = {
    id: execId,
    trade_id: tradeId,
    intent_id: intentId,
    execution_type: 'close',
    executed_at: nowIso(),
    price,
    amount,
    qty_base: qtyBase,
    fee: 0,
    fee_currency: 'USD',
    exchange: isLiveLikeMode(mode) ? 'coinbase' : 'paper',
    metadata: {
      source: 'worker_close_ledger',
      job_id: String(job.id),
      pair,
      price_source: priceSource,
      mode,
      worker_id: WORKER_ID,
    },
    created_at: nowIso(),
  };
  const { error } = await sb.from('trade_executions_prod').insert(row);
  if (error) throw error;
  return execId;
}
async function ensureCloseLedgerForJob({ job }) {
  try {
    if (!CLOSE_LEDGER_ENABLED) return { ok: true, did: false, code: 'disabled' };
    if (CLOSE_LEDGER_ASSUME_BOT_WRITES) return { ok: true, did: false, code: 'assume_bot_writes' };
    if (!job || job.type !== 'execute_intent') return { ok: true, did: false, code: 'not_execute_intent' };
    if (isLiveCloseJob(job)) return { ok: true, did: false, code: 'live_close_ledger_skipped' };

    const payload = job.payload || {};
    const action = safeTrim(payload.action);
    if (!isExitAction(action)) return { ok: true, did: false, code: 'not_close' };

    const intentId = safeTrim(job.intent_id || payload.intent_id || payload.intentId);
    if (!intentId) return { ok: false, did: false, code: 'close_ledger_missing_intent_id', detail: 'job.intent_id missing' };
    if (await closeAlreadyWrittenForIntent(intentId)) return { ok: true, did: false, code: 'close_already_written' };

    const intent = await fetchIntent(intentId).catch(() => null);
    const pair =
      safeTrim(payload.pair) ||
      safeTrim(intent?.raw_signal?.pair || intent?.raw_signal?.['pair']) ||
      normalizePairFromSymbol(payload.symbol || intent?.symbol);
    const mode =
      safeTrim(payload.execution_mode) ||
      safeTrim(intent?.execution_mode) ||
      'paper';

    if (isLiveLikeMode(mode)) return { ok: true, did: false, code: 'live_close_ledger_skipped' };

    let tradeId = safeTrim(payload.trade_id) || safeTrim(intent?.raw_signal?.trade_id || intent?.raw_signal?.['trade_id']);
    let tradeRow = null;
    if (!tradeId) {
      tradeRow = await findOpenPaperTradeByPair(pair);
      tradeId = tradeRow ? tradeRow.id : null;
    } else {
      tradeRow = await fetchOpenTradeById(tradeId);
    }
    if (!tradeId) return { ok: false, did: false, code: 'close_ledger_no_trade_found', detail: `pair=${pair || '(null)'}` };

    const tradeMode = tradeRow?.metadata?.mode ? String(tradeRow.metadata.mode) : mode;
    const hasFill = await hasAnyFill(tradeId);
    if (!hasFill && !isPaperLikeMode(tradeMode)) {
      return { ok: false, did: false, code: 'close_ledger_missing_fill', detail: `trade_id=${tradeId}` };
    }

    const amount = await getTradeAmount(tradeId, tradeRow);
    const qtyBase = await getTradeQtyBase(tradeId, tradeRow);
    const priceMarks = await getPriceFromMarketMarks(pair);
    const priceLastFill = await getLastFillPrice(tradeId);
    const price = priceMarks != null ? priceMarks : priceLastFill;
    const priceSource = priceMarks != null ? 'market_marks' : priceLastFill != null ? 'last_fill' : null;
    if (price == null) return { ok: false, did: false, code: 'close_ledger_missing_price', detail: `pair=${pair} trade_id=${tradeId}` };

    const execId = await writeCloseLedgerRow({
      job,
      intentId,
      tradeId,
      pair,
      amount,
      qtyBase,
      price,
      priceSource,
      mode: tradeMode,
    });
    log({
      tag: TAG,
      msg: 'CLOSE_LEDGER_WRITTEN',
      ts: nowIso(),
      job_id: job.id,
      intent_id: intentId,
      trade_id: tradeId,
      exec_id: execId,
      pair,
      price,
      amount,
      qty_base: qtyBase,
      price_source: priceSource,
      trade_mode: tradeMode,
    });
    return { ok: true, did: true, code: 'close_ledger_written', exec_id: execId };
  } catch (err) {
    return { ok: false, did: false, code: 'close_ledger_exception', detail: String(err && err.message ? err.message : err) };
  }
}

// ---------- selfheal ----------
async function tradeIsOpen(tradeId) {
  if (!tradeId) return null;
  const row = await fetchOpenTradeById(tradeId);
  if (!row) return null;
  const mode = row?.metadata?.mode ? String(row.metadata.mode) : null;
  if (!isPaperLikeMode(mode)) return false;
  return String(row.status || '').toLowerCase() === 'open';
}
async function selfhealRequeueSameJob(oldJob, patchPayload) {
  const mergedPayload = {
    ...(oldJob.payload || {}),
    ...(patchPayload || {}),
    selfheal_prev_status: oldJob.status,
    selfheal_prev_last_error: oldJob.last_error,
    selfheal_prev_last_step: oldJob.last_step,
  };
  const { error } = await sb
    .from('execution_jobs')
    .update({
      status: 'queued',
      claimed_by: null,
      claimed_at: null,
      heartbeat_at: nowIso(),
      last_step: 'selfheal_requeued',
      last_error: null,
      attempts: 0,
      run_at: nowIso(),
      payload: mergedPayload,
    })
    .eq('id', oldJob.id);
  if (error) throw error;
}
async function selfhealDeadletters(batch = SELFHEAL_BATCH) {
  if (!SELFHEAL_DEADLETTER) return 0;
  const { data, error } = await sb
    .from('execution_jobs')
    .select('id,type,status,payload,attempts,created_at,claimed_by,claimed_at,heartbeat_at,last_step,last_error,run_at,intent_id')
    .eq('status', 'failed')
    .eq('type', 'execute_intent')
    .order('created_at', { ascending: true })
    .limit(batch);
  if (error) throw error;

  let requeued = 0;
  for (const job of data || []) {
    const payload = job.payload || {};
    const action = safeTrim(payload.action).toLowerCase();
    if (!isExitAction(action)) continue;
    const intentId = safeTrim(job.intent_id || payload.intent_id || payload.intentId);
    const intent = await fetchIntent(intentId).catch(() => null);
    const tradeId = safeTrim(payload.trade_id || intent?.raw_signal?.trade_id);
    if (!tradeId) continue;
    const open = await tradeIsOpen(tradeId).catch(() => false);
    if (!open) continue;
    await selfhealRequeueSameJob(job, { selfheal_reason: 'trade_still_open' });
    requeued += 1;
  }
  return requeued;
}

// ---------- loop ----------
async function loop() {
  while (true) {
    try {
      log({ tag: TAG, msg: 'POLL', ts: nowIso(), types: TYPES });

      if (SELFHEAL_DEADLETTER) {
        log({ tag: TAG, msg: 'STEP_START', ts: nowIso(), step: 'selfhealDeadletters', batch: SELFHEAL_BATCH });
        const requeued = await selfhealDeadletters(SELFHEAL_BATCH);
        log({ tag: TAG, msg: 'STEP_OK', ts: nowIso(), step: 'selfhealDeadletters', requeued });
      }

      log({ tag: TAG, msg: 'STEP_START', ts: nowIso(), step: 'pickQueuedJob', types: TYPES });
      const candidate = await pickQueuedJob(TYPES);
      log({
        tag: TAG,
        msg: 'STEP_OK',
        ts: nowIso(),
        step: 'pickQueuedJob',
        found: Boolean(candidate),
        candidate_id: candidate ? candidate.id : null,
        candidate_type: candidate ? candidate.type : null,
        candidate_intent_id: candidate ? candidate.intent_id : null,
      });
      if (!candidate) {
        await sleep(POLL_MS);
        continue;
      }

      log({ tag: TAG, msg: 'STEP_START', ts: nowIso(), step: 'claimJob', candidate_id: candidate.id });
      const claimed = await claimJob(candidate.id);
      log({
        tag: TAG,
        msg: 'STEP_OK',
        ts: nowIso(),
        step: 'claimJob',
        claimed: Boolean(claimed),
        claimed_id: claimed ? claimed.id : null,
        claimed_type: claimed ? claimed.type : null,
        claimed_intent_id: claimed ? claimed.intent_id : null,
      });
      if (!claimed) {
        await sleep(250);
        continue;
      }

      log({
        tag: TAG,
        msg: 'JOB_CLAIMED',
        ts: nowIso(),
        id: claimed.id,
        type: claimed.type,
        intent_id: claimed.intent_id,
        attempts: claimed.attempts,
      });

      await touchHeartbeat(claimed.id, 'policy_preflight');
      const preflight = await policyPreflight(claimed);
      log({
        tag: TAG,
        msg: 'policy_preflight',
        ts: nowIso(),
        id: claimed.id,
        intent_id: claimed.intent_id,
        allow: preflight.allow,
        code: preflight.code,
        symbol: preflight.symbol || null,
      });
      if (!preflight.allow) {
        await cancelJobSkipped(claimed.id, `policy_cancelled_${preflight.code}`, preflight.code);
        log({
          tag: TAG,
          msg: 'JOB_POLICY_CANCELLED',
          ts: nowIso(),
          id: claimed.id,
          type: claimed.type,
          intent_id: claimed.intent_id,
          symbol: preflight.symbol || null,
          code: preflight.code,
          side_permission: preflight.policy?.side_permission || null,
          size_tier: preflight.policy?.size_tier || null,
          policy_reason: preflight.policy?.policy_reason || null,
          direction_score: preflight.policy?.direction_score || null,
          permission_score: preflight.policy?.permission_score || null,
        });
        await sleep(250);
        continue;
      }

      await touchHeartbeat(claimed.id, 'direct_execution');
      log({ tag: TAG, msg: 'STEP: direct_execution', ts: nowIso(), id: claimed.id, intent_id: claimed.intent_id });
      const stopHeartbeat = startHeartbeat(claimed.id, JOB_HEARTBEAT_MS);
      let result;
      try {
        result = await executeDirect(claimed);
      } finally {
        stopHeartbeat();
      }

      if (result.ok) {
        const closeConfirm = getLiveCloseConfirmationState(result, claimed);
        log({
          tag: TAG,
          msg: 'DIRECT_EXECUTION_OK',
          ts: nowIso(),
          id: claimed.id,
          type: claimed.type,
          intent_id: claimed.intent_id,
          response_ok: result.response?.ok ?? true,
          response_error: result.response?.error || null,
          order_id: result.response?.order_id || null,
          action: result.response?.action || claimed.payload?.action || null,
          mode: result.response?.mode || claimed.payload?.execution_mode || null,
          live_close_confirmed: closeConfirm.liveClose ? closeConfirm.confirmed : null,
          live_close_code: closeConfirm.liveClose ? closeConfirm.code : null,
        });

        if (closeConfirm.liveClose && !closeConfirm.confirmed) {
          const attempts = Number(claimed.attempts || 0);
          const errCode = closeConfirm.code || 'live_close_unconfirmed';
          if (attempts + 1 >= MAX_ATTEMPTS) {
            await markFailedDeadletter(claimed.id, errCode);
            log({
              tag: TAG,
              msg: 'JOB_DEADLETTERED',
              ts: nowIso(),
              id: claimed.id,
              type: claimed.type,
              last_error: errCode,
              detail: result.detail || null,
            });
          } else {
            await requeueWithBackoff(claimed, errCode);
            log({
              tag: TAG,
              msg: 'JOB_LIVE_CLOSE_PENDING_RETRYING',
              ts: nowIso(),
              id: claimed.id,
              type: claimed.type,
              last_error: errCode,
            });
          }
          await sleep(250);
          continue;
        }

        let ledger = { ok: true, did: false, code: 'not_needed' };
        if (isLiveCloseJob(claimed)) {
          await touchHeartbeat(claimed.id, 'live_close_skip_worker_ledger');
          ledger = { ok: true, did: false, code: 'live_close_journaled_by_bot' };
        } else {
          await touchHeartbeat(claimed.id, 'close_ledger');
          ledger = await ensureCloseLedgerForJob({ job: claimed });
          if (!ledger.ok) {
            const attempts = Number(claimed.attempts || 0);
            const errCode = ledger.code || 'close_ledger_failed';
            if (attempts + 1 >= MAX_ATTEMPTS) {
              await markFailedDeadletter(claimed.id, errCode);
              log({
                tag: TAG,
                msg: 'JOB_DEADLETTERED_CLOSE_LEDGER',
                ts: nowIso(),
                id: claimed.id,
                type: claimed.type,
                last_error: errCode,
                detail: ledger.detail,
              });
            } else {
              await requeueWithBackoff(claimed, errCode);
              log({
                tag: TAG,
                msg: 'JOB_CLOSE_LEDGER_FAILED_RETRYING',
                ts: nowIso(),
                id: claimed.id,
                type: claimed.type,
                last_error: errCode,
                detail: ledger.detail,
              });
            }
            await sleep(250);
            continue;
          }
        }

        await touchHeartbeat(claimed.id, 'finalizing');
        await completeJob(claimed.id);
        log({
          tag: TAG,
          msg: 'JOB_COMPLETED',
          ts: nowIso(),
          id: claimed.id,
          type: claimed.type,
          close_ledger: ledger.code,
          live_close_confirmed: closeConfirm.liveClose ? closeConfirm.confirmed : null,
          live_close_code: closeConfirm.liveClose ? closeConfirm.code : null,
        });
      } else {
        const intentId = safeTrim(claimed.intent_id || claimed.payload?.intent_id || claimed.payload?.intentId);
        const dedupe = await detectAlreadyExecutedForIntent(intentId).catch(() => ({ alreadyExecuted: false, source: null }));
        if (dedupe.alreadyExecuted) {
          await touchHeartbeat(claimed.id, 'already_executed_conflict');
          await completeJob(claimed.id);
          log({
            tag: TAG,
            msg: 'JOB_COMPLETED_ALREADY_EXECUTED_CONFLICT',
            ts: nowIso(),
            id: claimed.id,
            type: claimed.type,
            intent_id: intentId || null,
            conflict_code: result.code,
            conflict_detail: result.detail || null,
            dedupe_source: dedupe.source || null,
            trade_id: dedupe.trade?.id || dedupe.execution?.trade_id || null,
            trade_status: dedupe.trade?.status || null,
            close_validation: dedupe.trade?.close_validation || null,
          });
          await sleep(250);
          continue;
        }

        const attempts = Number(claimed.attempts || 0);
        if (attempts + 1 >= MAX_ATTEMPTS) {
          await markFailedDeadletter(claimed.id, result.code);
          log({
            tag: TAG,
            msg: 'JOB_DEADLETTERED',
            ts: nowIso(),
            id: claimed.id,
            type: claimed.type,
            last_error: result.code,
            detail: result.detail,
          });
        } else {
          await requeueWithBackoff(claimed, result.code);
          log({
            tag: TAG,
            msg: 'JOB_DIRECT_EXECUTION_FAILED_RETRYING',
            ts: nowIso(),
            id: claimed.id,
            type: claimed.type,
            last_error: result.code,
            detail: result.detail,
          });
        }
      }

      await sleep(250);
    } catch (err) {
      log({ tag: TAG, msg: 'LOOP_ERROR', ts: nowIso(), ...summarizeUnknownError(err) });
      await sleep(Math.max(1000, POLL_MS));
    }
  }
}

loop();
