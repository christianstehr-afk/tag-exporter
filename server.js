/**
 * TAG por patente - exportador (v2)
  * Fuente: https://app.smartreport.cl
   * NOTA: automatizacion del datepicker escrita sin poder probarla local.
    * Revisar logs de Railway si algo falla.
     */

     const express = require('express');
     const path = require('path');
     const archiver = require('archiver');
     const { chromium } = require('playwright');

     const BASE_URL = 'https://app.smartreport.cl';
     const SR_USER = process.env.SR_USER;
     const SR_PASS = process.env.SR_PASS;
     const PORT = process.env.PORT || 8080;

     const app = express();
     app.use(express.json());
     app.use(express.static(path.join(__dirname, 'public')));

     let browser = null;
     let context = null;

     async function initBrowser() {
     if (browser) return;
     console.log('[browser] iniciando Chromium...');
     browser = await chromium.launch({
     headless: true,
     args: ['--no-sandbox', '--disable-dev-shm-usage'],
     });
     context = await browser.newContext({ acceptDownloads: true });
     console.log('[browser] listo.');
     }

     async function login(page) {
     if (!SR_USER || !SR_PASS) {
     throw new Error('Faltan las variables de entorno SR_USER / SR_PASS');
     }
     await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
     await page.waitForSelector('input[aria-label="Ingresa tu usuario"]', { timeout: 20000 });
     await page.fill('input[aria-label="Ingresa tu usuario"]', SR_USER);
     await page.fill('input[aria-label="Ingresa tu contraseña"]', SR_PASS);
     await page.locator('button', { hasText: /^ENTRAR$/i }).click();
     await page.waitForURL('**/dashboard', { timeout: 20000 });
     console.log('[login] sesion iniciada.');
     }

     async function getAuthenticatedPage() {
     await initBrowser();
     const page = await context.newPage();
     await page.goto(`${BASE_URL}/Report/Tag`, { waitUntil: 'networkidle' });
     if (page.url().includes('/login')) {
     await login(page);
     await page.goto(`${BASE_URL}/Report/Tag`, { waitUntil: 'networkidle' });
     }
     await page.waitForSelector('table tbody tr', { timeout: 20000 });
     return page;
     }

     let queue = Promise.resolve();
     function enqueue(fn) {
     const run = queue.then(fn, fn);
     queue = run.catch(() => {});
     return run;
     }

     async function uncheckMapaIfNeeded(page) {
     const mapaInput = page.locator('.checkBoxMap input[type="checkbox"]');
     const checked = await mapaInput.isChecked().catch(() => null);
     if (checked === null) return;
     if (checked) {
     await page.locator('.checkBoxMap').click();
     }
     }

     async function togglePlate(page, plate) {
     const row = page.locator('table tbody tr').filter({ hasText: new RegExp(`\\b${plate}\\b`) });
     await row.locator('.q-checkbox').first().click();
     }

     async function pickDateTime(page, inputIndex, targetDate) {
     const input = page.locator('.dp__input').nth(inputIndex);
     await input.click();
     const menu = page.locator('.dp__menu').last();
     await menu.waitFor({ state: 'visible', timeout: 10000 });
     const monthYearSelects = menu.locator('.dp__month_year_select');
     await monthYearSelects.nth(0).click();
     const monthOverlay = menu.locator('.dp__overlay').last();
     await monthOverlay.waitFor({ state: 'visible', timeout: 5000 });
     const monthIndex = targetDate.getMonth() + 1;
     await monthOverlay.locator('.dp__overlay_cell, .dp__overlay_cell_active').nth(monthIndex - 1).click();
     await monthYearSelects.nth(1).click();
     const yearOverlay = menu.locator('.dp__overlay').last();
     await yearOverlay.waitFor({ state: 'visible', timeout: 5000 });
     const yearText = String(targetDate.getFullYear());
     await yearOverlay.locator('.dp__overlay_cell, .dp__overlay_cell_active').filter({ hasText: new RegExp(`^${yearText}$`) }).first().click();
     const day = String(targetDate.getDate());
     const dayCells = menu.locator('.dp__cell_inner:not(.dp__cell_offset)').filter({ hasText: new RegExp(`^${day}$`) });
     await dayCells.first().click();
     const selectBtn = menu.locator('.dp__action_select');
     if (await selectBtn.count().catch(() => 0)) {
     await selectBtn.click().catch(() => {});
     }
     await menu.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
     }

     async function setDateRange(page, fromDate, toDate) {
     await pickDateTime(page, 0, fromDate);
     await pickDateTime(page, 1, toDate);
     }

     function pad2(n) {
     return String(n).padStart(2, '0');
     }
     function formatYYYYMMDD(d) {
     return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
     }

     app.get('/health', (req, res) => res.json({ ok: true }));

     app.get('/api/patentes', async (req, res) => {
     try {
     const result = await enqueue(async () => {
     const page = await getAuthenticatedPage();
     const patentes = await page.$$eval('table tbody tr', (rows) =>
     rows
     .map((r) => {
     const c = r.querySelectorAll('td');
     return {
     plate: c[1]?.innerText.trim(),
     model: c[2]?.innerText.trim(),
     year: c[3]?.innerText.trim(),
     brand: c[4]?.innerText.trim(),
     color: c[5]?.innerText.trim(),
     };
     })
     .filter((p) => p.plate)
     );
     await page.close();
     return patentes;
     });
     res.json(result);
     } catch (err) {
     console.error('[api/patentes] error:', err);
     res.status(500).json({ error: String(err.message || err) });
     }
     });

     app.post('/api/export', async (req, res) => {
     const { plates, from, to } = req.body || {};
     if (!Array.isArray(plates) || plates.length === 0) {
     return res.status(400).json({ error: 'Selecciona al menos una patente.' });
     }
     if (!from || !to) {
     return res.status(400).json({ error: 'Falta el rango de fechas.' });
     }
     const fromDate = new Date(from);
     const toDate = new Date(to);
     if (isNaN(fromDate) || isNaN(toDate)) {
     return res.status(400).json({ error: 'Rango de fechas invalido.' });
     }
     try {
     await enqueue(async () => {
     const page = await getAuthenticatedPage();
     await setDateRange(page, fromDate, toDate);
     await uncheckMapaIfNeeded(page);
     res.attachment(`TAG_${formatYYYYMMDD(fromDate)}-${formatYYYYMMDD(toDate)}.zip`);
     const archive = archiver('zip', { zlib: { level: 9 } });
     archive.on('warning', (w) => console.warn('[archiver] warning:', w));
     archive.on('error', (e) => { throw e; });
     archive.pipe(res);
     let lastPlate = null;
     for (const plate of plates) {
     try {
     if (lastPlate) await togglePlate(page, lastPlate);
     await togglePlate(page, plate);
     lastPlate = plate;
     await page.locator('button.lupa').click();
     const modal = page.locator('.q-dialog--modal');
     await modal.waitFor({ state: 'visible', timeout: 30000 });
     const pdfButton = modal.locator('button').filter({ hasText: /^PDF$/ }).first();
     const [download] = await Promise.all([
     page.waitForEvent('download', { timeout: 60000 }),
     pdfButton.click(),
     ]);
     const stream = await download.createReadStream();
     const filename = `TAG_${formatYYYYMMDD(fromDate)}-${formatYYYYMMDD(toDate)}_${plate}.pdf`;
     archive.append(stream, { name: filename });
     const closeBtn = modal.locator('button').filter({ hasText: /^close$/ }).first();
     await closeBtn.click({ timeout: 5000 }).catch(() => {});
     } catch (plateErr) {
     console.error(`[export] ${plate} fallo:`, plateErr);
     archive.append(String(plateErr.message || plateErr), { name: `TAG_${plate}_ERROR.txt` });
     }
     }
     await archive.finalize();
     await page.close();
     });
     } catch (err) {
     console.error('[api/export] error:', err);
     if (!res.headersSent) {
     res.status(500).json({ error: String(err.message || err) });
     } else {
     res.end();
     }
     }
     });

     process.on('SIGTERM', async () => {
     await browser?.close().catch(() => {});
     process.exit(0);
     });

     app.listen(PORT, () => {
     console.log(`tag-exporter escuchando en :${PORT}`);
     });
     
