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
const STATUS_CELL = 'F5'; // Status cell in _config sheet

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

// --- Format runtime (ms) as "42s" or "2m 13s" or "1h 5m 20s" ---
function formatRuntime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  } else if (seconds > 0) {
    return `${seconds}s`;
  } else {
    return `${ms}ms`;
  }
}

function getColorNameFromRGB(rgb) {
  return rgb || 'N/A';
}

// ===== GOOGLE SHEETS =====
async function authorize() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return await auth.getClient();
}

// Update status in Google Sheet with runtime
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
      values: [
        [
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
        ],
      ],
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
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.fill('#j_username', USERNAME);
  await page.fill('#j_password', PASSWORD);
  await page.click('button.primary_button');
  await page.waitForTimeout(5000);
  log('✅ Logged in.');
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

  const calendarIcon = await page.$('div.js-custom_datepicker i.js-calendar_icon');
  if (!calendarIcon) {
    log('❌ Calendar icon not found!');
    return false;
  }
  await calendarIcon.click({ timeout: 5000 });
  log('🟢 Calendar icon clicked.');

  await page.waitForSelector('div.js-custom_datepicker table', { timeout: 5000 });

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
      log(`❌ Cannot find next month button. Calendar stuck at ${currentHeader}`);
      return false;
    }
    await nextBtn.click();
    await page.waitForTimeout(500);
  }

  const dateCell = await page.$(`div.js-custom_datepicker td[data-day="${formattedDate}"]`);
  if (!dateCell) {
    log(`❌ Date cell for ${formattedDate} not found!`);
    return false;
  }

  const classList = await dateCell.getAttribute('class');
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
      if (imgUrl !== 'N/A' && imgUrl.includes('image=/https'))
        imgUrl = imgUrl.replace('image=/https', 'image=https');

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

      let length = 'N/A',
        weight = 'N/A',
        certificate = 'N/A',
        diameter = 'N/A',
        noofbuds = 'N/A';
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
        } else first_quantity = available_quantity;
      }

      const BASE = 'https://shop.holex.com';
      let productUrl = 'N/A';
      try {
        const rel = await product
          .$eval('div.name_fav a', (el) => el.getAttribute('href'))
          .catch(() => null);
        if (rel)
          productUrl = /^https?:\/\//i.test(rel.trim())
            ? rel.trim()
            : BASE.replace(/\/+$/, '') + '/' + rel.trim().replace(/^\/+/, '');
      } catch (err) {
        productUrl = 'N/A';
      }

      function cleanQuantity(text) {
        return text ? text.replace(/^x\s*/, '').trim() : 'N/A';
      }
      const rows = await product.$$('div.input_row');
      let prices = [];
      for (const row of rows) {
        const className = await row.evaluate((el) => el.className);
        const inputReadonly = await row.$('input[readonly]');
        if (className.includes('disabled') || inputReadonly) continue;
        const priceEl = await row.$('span.price_text');
        let price = 'N/A';
        if (priceEl)
          price = sanitize(
            await priceEl.evaluate((el) => el.getAttribute('from-price') || el.textContent)
          ).replace(',', '.');
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
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(12000);
    pageNum++;
  }

  log(`📭 Finished scraping ${pageNum} pages (${allProducts.length} products).`);
  return allProducts;
}

// ===== MAIN SCRIPT =====
(async () => {
  const startTime = Date.now(); // ⏱️ Start timer

  let browser = null;
  let authClient = null;
  let totalProductsScraped = 0;

  try {
    // Initialize Google Sheets client early for status updates
    authClient = await authorize();

    // Update status to "Running"
    await updateStatus(authClient, 'running', startTime);

    // Launch browser
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(90000);

    log('🚀 Script started.');

    const packingDate = await readPackingDate(authClient);
    await login(page);
    await page.goto(`${ANTHURIUM_BASE_URL}/en_US/All-products/Flowers/c/Flowers`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(3000);
    await closePopup(page);

    // ===== SELECT DATE WITH SAFETY CHECK =====
    const dateSelected = await selectPackingDate(page, packingDate);
    if (!dateSelected) {
      log(`⚠️ Packing date ${packingDate} is disabled. Writing "No products found" and exiting.`);
      await writeHeaders(authClient);
      await writeProducts(authClient, [{ name: `No products found {${packingDate}}` }], true);
      await updateStatus(authClient, 'date-disabled', startTime);
      await browser.close();
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
      await browser.close();
      log(`🏁 Script finished. Runtime: ${formatRuntime(Date.now() - startTime)}`);
      return;
    }

    await writeHeaders(authClient);
    let isFirstUrl = true;

    for (const url of urls) {
      log(`➡️ Scraping URL: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await closePopup(page);

      let products = await scrapeAllPages(page);
      totalProductsScraped += products.length;
      await writeProducts(authClient, products, isFirstUrl);
      isFirstUrl = false;
      log(`🟢 Finished scraping URL: ${url} (${products.length} products).`);
    }

    log(`🎉 All URLs processed. Total products: ${totalProductsScraped}`);

    // Update status with success or no-products
    if (totalProductsScraped > 0) {
      await updateStatus(authClient, 'success', startTime);
    } else {
      await updateStatus(authClient, 'no-products', startTime);
    }

    log(`🏁 Script finished successfully! Runtime: ${formatRuntime(Date.now() - startTime)}`);
  } catch (err) {
    log(`❌ ERROR: ${err.message}`);

    // Update status with error
    if (authClient) {
      try {
        await updateStatus(authClient, 'error', startTime, err.message?.substring(0, 50));
      } catch (updateErr) {
        log(`❌ Failed to update error status: ${updateErr.message}`);
      }
    }

    process.exitCode = 1;
  } finally {
    if (browser) {
      await browser.close();
      log('🔒 Browser closed.');
    }
  }
})();
