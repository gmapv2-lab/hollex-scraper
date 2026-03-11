require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ===== CONFIG =====
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CONFIG_SHEET = '_config';
const SHEET_NAME = process.env.SHEET_NAME;
const CREDENTIALS_PATH = path.join(__dirname, process.env.CREDENTIALS_PATH);
const USERNAME = process.env.HOLEX_USERNAME;
const PASSWORD = process.env.HOLEX_PASSWORD;
const LOGIN_URL = process.env.LOGIN_URL;
const ANTHURIUM_BASE_URL = process.env.ANTHURIUM_BASE_URL;
const LOG_PATH = path.join(__dirname, process.env.LOG_PATH || 'scraper.log');
const STATUS_CELL = 'F5';

// ===== UTILITY FUNCTIONS =====
function log(message) {
  const timestamp = new Date().toISOString();
  const fullMessage = `[${timestamp}] ${message}\n`;
  console.log(fullMessage.trim());
  fs.appendFileSync(LOG_PATH, fullMessage);
}

function sanitize(text = '') {
  if (!text) return 'N/A';
  return String(text)
    .replace('â‚¬', '€')
    .replace(/[^\x20-\x7E€$]/g, '')
    .trim();
}

function getUaeTimeFormatted() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(',', '');
}

function formatRuntime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  if (seconds > 0) return `${seconds}s`;
  return `${ms}ms`;
}

function getColorNameFromRGB(rgb) {
  return rgb || 'N/A';
}

function ensureDebugDir() {
  const debugDir = path.join(__dirname, 'debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
  return debugDir;
}

async function saveDebugState(page, name) {
  try {
    const debugDir = ensureDebugDir();
    const safeName = name.replace(/[^\w.-]/g, '_');

    const title = await page.title().catch(() => '');
    const url = page.url();
    const html = await page.content().catch(() => '');
    const bodyText = await page.locator('body').innerText().catch(() => '');

    fs.writeFileSync(path.join(debugDir, `${safeName}.html`), html || '');
    fs.writeFileSync(path.join(debugDir, `${safeName}.txt`), bodyText || '');

    await page.screenshot({
      path: path.join(debugDir, `${safeName}.png`),
      fullPage: true,
    });

    log(`🧾 Debug saved: ${safeName}`);
    log(`🌐 Debug URL (${safeName}): ${url}`);
    log(`📄 Debug Title (${safeName}): ${title}`);
    log(`📝 Debug Body sample (${safeName}): ${(bodyText || '').slice(0, 800)}`);
  } catch (err) {
    log(`ℹ️ Failed saving debug state "${name}": ${err.message}`);
  }
}

function detectChallenge(text = '') {
  const lower = text.toLowerCase();
  const challengeWords = [
    'just a moment',
    'checking your browser',
    'verify you are human',
    'access denied',
    'attention required',
    'cloudflare',
    'captcha',
    'performing security verification',
    'malicious bots',
  ];
  return challengeWords.find((word) => lower.includes(word)) || null;
}

// ===== GOOGLE SHEETS =====
async function authorize() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return await auth.getClient();
}

async function updateStatus(authClient, status, startTime, errorMessage) {
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  let statusText;

  if (status === 'running') {
    statusText = '🟡 Scraping in progress...';
  } else {
    const runtime = formatRuntime(Date.now() - startTime);
    const timestamp = getUaeTimeFormatted();

    switch (status) {
      case 'success':
        statusText = `✅ ${timestamp} — ${runtime}`;
        break;
      case 'error':
        statusText = `❌ Failed ${timestamp} — ${runtime}${errorMessage ? ` - ${errorMessage}` : ''}`;
        break;
      case 'no-products':
        statusText = `⚠️ No products found ${timestamp} — ${runtime}`;
        break;
      case 'no-urls':
        statusText = `⚠️ No URLs provided ${timestamp} — ${runtime}`;
        break;
      case 'date-disabled':
        statusText = `⚠️ Date disabled ${timestamp} — ${runtime}`;
        break;
      default:
        statusText = `${timestamp} — ${runtime}`;
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONFIG_SHEET}!${STATUS_CELL}`,
    valueInputOption: 'RAW',
    resource: { values: [[statusText]] },
  });

  log(`📌 Updated status in ${STATUS_CELL}: ${statusText}`);
}

async function readPackingDate(authClient) {
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CONFIG_SHEET}!C5`,
  });
  const date = res.data.values?.[0]?.[0] || '';
  log(`📌 Packing date from sheet: ${date}`);
  return date;
}

async function writeHeaders(authClient) {
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A1:R1`,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        'Name',
        'Tag',
        'Image URL',
        'Origin',
        'Length',
        'Diameter',
        'No of Buds',
        'Weight',
        'Certificate',
        'Farm',
        'Color',
        'First Price',
        'Packing Value',
        'Available Quantity',
        'Product URL',
        'Second Price',
        'Third Price',
        'Time',
      ]],
    },
  });
  log('✅ Header row written.');
}

// ===== WRITE PRODUCTS =====
async function writeProducts(authClient, rows, isFirstUrl = false) {
  if (!rows || !rows.length) return;
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  if (isFirstUrl) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A2:R`,
    });
    log('🧹 Old product data cleared (all columns).');
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:A`,
  });
  const startRow = (res.data.values?.length || 1) + 1;

  const values = rows.map((p) => {
    if (p.name && p.name.startsWith('No products found')) return [p.name];

    const secondPriceCombined =
      p.secondPrice && p.second_quantity ? `${p.secondPrice} × ${p.second_quantity}` : 'N/A';
    const thirdPriceCombined =
      p.thirdPrice && p.third_quantity ? `${p.thirdPrice} × ${p.third_quantity}` : 'N/A';

    return [
      p.name || 'N/A',
      p.tag || 'N/A',
      p.imgUrl || 'N/A',
      p.origin || 'N/A',
      p.length || 'N/A',
      p.diameter || 'N/A',
      p.noofbuds || 'N/A',
      p.weight || 'N/A',
      p.certificate || 'N/A',
      p.farm || 'N/A',
      p.color || 'N/A',
      p.stemPrice ? `${p.stemPrice} × ${p.quantity || 'N/A'}` : 'N/A',
      p.first_quantity || 'N/A',
      p.available_quantity || 'N/A',
      p.productUrl || 'N/A',
      secondPriceCombined,
      thirdPriceCombined,
      p.time || getUaeTimeFormatted(),
    ];
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A${startRow}`,
    valueInputOption: 'USER_ENTERED',
    resource: { values },
  });

  log(`✅ Wrote ${rows.length} rows starting at row ${startRow}.`);
}

// ===== PLAYWRIGHT HELPERS =====
async function login(page) {
  log('🔐 Logging in...');

  await page.goto(LOGIN_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });

  await page.waitForTimeout(5000);
  await saveDebugState(page, 'login-page-before-submit');

  log(`Username field count: ${await page.locator('#j_username').count()}`);
  log(`Password field count: ${await page.locator('#j_password').count()}`);

  const initialTitle = await page.title().catch(() => '');
  const initialBody = await page.locator('body').innerText().catch(() => '');
  const initialChallenge = detectChallenge(`${initialTitle}\n${initialBody}`);

  if (initialChallenge) {
    throw new Error(`Security / bot challenge detected before login: ${initialChallenge}`);
  }

  const usernameField = page.locator('#j_username').first();
  const passwordField = page.locator('#j_password').first();
  const loginButton = page.locator('button.primary_button').first();

  await usernameField.waitFor({ state: 'visible', timeout: 30000 });
  log('✅ Username field is visible');
  await usernameField.fill(USERNAME);
  log('✅ Username filled');

  await passwordField.waitFor({ state: 'visible', timeout: 30000 });
  log('✅ Password field is visible');
  await passwordField.fill(PASSWORD);
  log('✅ Password filled');

  await loginButton.waitFor({ state: 'visible', timeout: 30000 });
  await loginButton.click();
  log('✅ Login button clicked');

  await page.waitForTimeout(12000);
  await saveDebugState(page, 'login-page-after-submit');

  const afterTitle = await page.title().catch(() => '');
  const afterUrl = page.url();
  const afterBody = await page.locator('body').innerText().catch(() => '');
  const afterChallenge = detectChallenge(`${afterTitle}\n${afterBody}`);

  log(`🌐 URL after login click: ${afterUrl}`);
  log(`📄 Title after login click: ${afterTitle}`);

  if (afterChallenge) {
    throw new Error(`Blocked by Cloudflare / anti-bot challenge after login: ${afterChallenge}`);
  }

  const stillOnLogin =
    (await page.locator('#j_username').count().catch(() => 0)) > 0 &&
    (await page.locator('#j_password').count().catch(() => 0)) > 0;

  if (stillOnLogin && afterUrl.includes('login')) {
    throw new Error('Login failed: still on login page after submit');
  }

  log('✅ Login confirmed.');
}

async function closePopup(page) {
  const closeBtn = await page.$(
    '#cboxClose, .fancybox-close, .popup-close, .modal-close, .close-popup'
  );
  if (closeBtn) {
    await closeBtn.click();
    log('🧼 Closed popup.');
  }
}

async function autoScroll(page) {
  let prevHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(1500);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    if (newHeight === prevHeight) break;
    prevHeight = newHeight;
  }
  log('✅ Scrolling complete.');
}

// ===== SELECT PACKING DATE =====
async function selectPackingDate(page, dateStr) {
  log(`📅 Selecting packing date: ${dateStr}`);

  const [month, day, year] = dateStr.split('/');
  const formattedDate = `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`;

  const blockingBanner = await page.$(
    'div.alert, div.hl_notification, header.js-mainHeader .hlx_notification'
  );
  if (blockingBanner) {
    await page.evaluate((el) => el.remove(), blockingBanner);
    log('🧹 Removed a blocking alert/banner.');
  }

  const pageTitle = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const challenge = detectChallenge(`${pageTitle}\n${bodyText}`);

  if (challenge) {
    await saveDebugState(page, 'challenge-before-date-select');
    throw new Error(`Blocked by Cloudflare / anti-bot challenge before date selection: ${challenge}`);
  }

  const calendarIcon = await page.$('div.js-custom_datepicker i.js-calendar_icon');
  if (!calendarIcon) {
    await saveDebugState(page, 'calendar-not-found');
    throw new Error('Calendar icon not found. Page may not be logged in, may be blocked, or layout changed.');
  }

  await calendarIcon.click({ timeout: 5000 });
  log('🟢 Calendar icon clicked.');

  await page.waitForSelector('div.js-custom_datepicker table', { timeout: 15000 });

  async function getCalendarMonthYear() {
    const header = await page.$('div.js-custom_datepicker th.picker-switch');
    return header ? (await header.innerText()).trim() : '';
  }

  const targetMonthYear = new Date(`${year}-${month}-01`).toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
  });

  for (let i = 0; i < 12; i++) {
    const currentHeader = await getCalendarMonthYear();
    if (currentHeader === targetMonthYear) break;

    const nextBtn = await page.$('div.js-custom_datepicker th.next');
    if (!nextBtn) {
      throw new Error(`Cannot find next month button. Calendar stuck at ${currentHeader}`);
    }

    await nextBtn.click();
    await page.waitForTimeout(500);
  }

  const dateCell = await page.$(`div.js-custom_datepicker td[data-day="${formattedDate}"]`);
  if (!dateCell) {
    throw new Error(`Date cell for ${formattedDate} not found`);
  }

  const classList = (await dateCell.getAttribute('class')) || '';
  if (classList.includes('disabled')) {
    log(`❌ Date ${formattedDate} is disabled and cannot be selected.`);
    return false;
  }

  await dateCell.click();
  log(`✅ Date selected: ${formattedDate}`);

  try {
    const continueBtn = await page.waitForSelector('button.confirm_select_date', { timeout: 3000 });
    if (continueBtn) {
      await continueBtn.click();
      log('✅ Confirmed date selection by clicking Continue.');
      await page.waitForTimeout(2000);
    }
  } catch (err) {
    log('ℹ️ No confirmation popup appeared.');
  }

  return true;
}

// ===== SCRAPING PRODUCTS =====
async function scrapeProducts(page) {
  const results = [];
  const cards = await page.$$('div.product-item');
  const time = getUaeTimeFormatted();

  for (const product of cards) {
    try {
      const name = sanitize(
        await product.$eval('div.name_fav span a', (el) => el.textContent).catch(() => 'N/A')
      );
      const tag = sanitize(
        await product.$eval('div.thumnail_section span', (el) => el.textContent).catch(() => 'N/A')
      );

      let imgUrl = await product
        .$eval('div.thumnail_section img', (el) => el.src)
        .catch(() => 'N/A');

      if (imgUrl !== 'N/A' && imgUrl.includes('image=/https')) {
        imgUrl = imgUrl.replace('image=/https', 'image=https');
      }

      const origin = sanitize(
        await product
          .$eval('div.country_icon_outer div.text', (el) => el.textContent)
          .catch(() => 'N/A')
      );

      let color = 'N/A';
      const colorElement = await product.$('span.hlx_plp_color');
      if (colorElement) {
        const rgb = await colorElement.evaluate((el) =>
          window.getComputedStyle(el).getPropertyValue('background-color')
        );
        color = getColorNameFromRGB(rgb);
      }

      let length = 'N/A';
      let weight = 'N/A';
      let certificate = 'N/A';
      let diameter = 'N/A';
      let noofbuds = 'N/A';

      const attrBlock = await product.$('.classification_attributes_block');
      if (attrBlock) {
        const items = await attrBlock.$$('li');
        for (const li of items) {
          const icon = await li.$('i');
          const text = sanitize(await li.$eval('p', (el) => el.textContent).catch(() => ''));
          if (icon) {
            const classList = await icon.getAttribute('class');
            if (classList.includes('length_icon')) length = text || 'N/A';
            else if (classList.includes('diameter_icon')) diameter = text || 'N/A';
            else if (classList.includes('weight_icon')) weight = text || 'N/A';
            else if (classList.includes('certificate_icon')) certificate = text || 'N/A';
          }
        }
      }

      let farm = 'N/A';
      const farmElement = await product.$(
        'div.classification_attributes_block.labels_attr div.classification_label_attributes'
      );
      if (farmElement) {
        farm = await farmElement
          .evaluate((el) => {
            const spans = el.querySelectorAll('span');
            spans.forEach((s) => s.remove());
            return el.textContent.trim();
          })
          .catch(() => 'N/A');
      }

      let first_quantity = 'N/A';
      let available_quantity = 'N/A';
      const packDiv = await product.$('div.text-left');
      const quantityDiv = await product.$('div.first_quantity');

      if (quantityDiv) {
        let rawQty = sanitize(await quantityDiv.evaluate((el) => el.textContent)).trim();
        rawQty = rawQty.replace(/assortment/i, '').trim();
        available_quantity = rawQty || 'N/A';

        if (packDiv) {
          const spans = await packDiv.$$('span');
          const unitName = spans[0]
            ? sanitize(await spans[0].evaluate((el) => el.textContent))
            : '';
          const unitCode = spans[1]
            ? sanitize(await spans[1].evaluate((el) => el.textContent))
            : '';
          first_quantity = `${unitName} (${unitCode}) ${available_quantity}`.trim();
        } else {
          first_quantity = available_quantity;
        }
      }

      const BASE = 'https://shop.holex.com';
      let productUrl = 'N/A';
      try {
        const rel = await product
          .$eval('div.name_fav a', (el) => el.getAttribute('href'))
          .catch(() => null);

        if (rel) {
          productUrl = /^https?:\/\//i.test(rel.trim())
            ? rel.trim()
            : BASE.replace(/\/+$/, '') + '/' + rel.trim().replace(/^\/+/, '');
        }
      } catch (err) {
        productUrl = 'N/A';
      }

      function cleanQuantity(text) {
        return text ? text.replace(/^x\s*/, '').trim() : 'N/A';
      }

      const rows = await product.$$('div.input_row');
      const prices = [];

      for (const row of rows) {
        const className = await row.evaluate((el) => el.className);
        const inputReadonly = await row.$('input[readonly]');
        if (className.includes('disabled') || inputReadonly) continue;

        const priceEl = await row.$('span.price_text');
        let price = 'N/A';
        if (priceEl) {
          price = sanitize(
            await priceEl.evaluate((el) => el.getAttribute('from-price') || el.textContent)
          ).replace(',', '.');
        }

        const quantityEl = await row.$('span.stock_unit.pieces_unit');
        const qty = quantityEl
          ? cleanQuantity(await quantityEl.evaluate((el) => el.textContent))
          : 'N/A';

        prices.push({ price, quantity: qty });
      }

      const stemPrice = prices[0]?.price || 'N/A';
      const quantity = prices[0]?.quantity || 'N/A';
      const secondPrice = prices[1]?.price || 'N/A';
      const second_quantity = prices[1]?.quantity || 'N/A';
      const thirdPrice = prices[2]?.price || 'N/A';
      const third_quantity = prices[2]?.quantity || 'N/A';

      results.push({
        name,
        tag,
        imgUrl,
        origin,
        length,
        diameter,
        noofbuds,
        weight,
        certificate,
        farm,
        color,
        stemPrice,
        quantity,
        first_quantity,
        available_quantity,
        productUrl,
        secondPrice,
        second_quantity,
        thirdPrice,
        third_quantity,
        time,
      });
    } catch (err) {
      log(`❌ Error scraping product: ${err.message}`);
    }
  }

  return results;
}

// ===== SCRAPE ALL PAGES =====
async function scrapeAllPages(page) {
  let allProducts = [];
  let pageNum = 1;

  while (true) {
    log(`📄 Scraping page ${pageNum}...`);
    await autoScroll(page);

    const products = await scrapeProducts(page);
    allProducts = allProducts.concat(products);

    const nextBtn = await page.$('li.pagination-next:not(.disabled) a[rel="next"]');
    if (!nextBtn) break;

    const nextUrl = await nextBtn.getAttribute('href');
    if (!nextUrl) break;

    const fullUrl = `${ANTHURIUM_BASE_URL}${nextUrl}`;
    log(`➡️ Moving to: ${fullUrl}`);

    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(12000);
    pageNum++;
  }

  log(`📭 Finished scraping ${pageNum} pages (${allProducts.length} products).`);
  return allProducts;
}

// ===== MAIN SCRIPT =====
(async () => {
  const startTime = Date.now();

  let browser = null;
  let context = null;
  let authClient = null;
  let totalProductsScraped = 0;

  try {
    authClient = await authorize();
    await updateStatus(authClient, 'running', startTime);

    const debugDir = ensureDebugDir();

    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      locale: 'en-US',
      recordVideo: {
        dir: debugDir,
        size: { width: 1366, height: 768 },
      },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(120000);

    log('🚀 Script started.');

    const packingDate = await readPackingDate(authClient);

    await login(page);

    await page.goto(`${ANTHURIUM_BASE_URL}/en_US/All-products/Flowers/c/Flowers`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await page.waitForTimeout(3000);
    await saveDebugState(page, 'flowers-page');
    await closePopup(page);

    const dateSelected = await selectPackingDate(page, packingDate);
    if (!dateSelected) {
      log(`⚠️ Packing date ${packingDate} is disabled. Writing "No products found" and exiting.`);
      await writeHeaders(authClient);
      await writeProducts(authClient, [{ name: `No products found {${packingDate}}` }], true);
      await updateStatus(authClient, 'date-disabled', startTime);
      log(`🏁 Script finished. Runtime: ${formatRuntime(Date.now() - startTime)}`);
      return;
    }

    const urls = (process.env.URLS || '')
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    if (!urls.length) {
      log('⚠️ No URLs provided. Exiting.');
      await updateStatus(authClient, 'no-urls', startTime);
      log(`🏁 Script finished. Runtime: ${formatRuntime(Date.now() - startTime)}`);
      return;
    }

    await writeHeaders(authClient);
    let isFirstUrl = true;

    for (const url of urls) {
      log(`➡️ Scraping URL: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForTimeout(3000);
      await closePopup(page);

      const products = await scrapeAllPages(page);
      totalProductsScraped += products.length;

      await writeProducts(authClient, products, isFirstUrl);
      isFirstUrl = false;

      log(`🟢 Finished scraping URL: ${url} (${products.length} products).`);
    }

    log(`🎉 All URLs processed. Total products: ${totalProductsScraped}`);

    if (totalProductsScraped > 0) {
      await updateStatus(authClient, 'success', startTime);
    } else {
      await updateStatus(authClient, 'no-products', startTime);
    }

    log(`🏁 Script finished successfully! Runtime: ${formatRuntime(Date.now() - startTime)}`);
  } catch (err) {
    log(`❌ ERROR: ${err.message}`);

    if (authClient) {
      try {
        await updateStatus(authClient, 'error', startTime, err.message?.substring(0, 80));
      } catch (updateErr) {
        log(`❌ Failed to update error status: ${updateErr.message}`);
      }
    }

    process.exitCode = 1;
  } finally {
    if (context) {
      await context.close();
      log('🎥 Browser context closed.');
    }

    if (browser) {
      await browser.close();
      log('🔒 Browser closed.');
    }
  }
})();
