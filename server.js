import http from 'node:http';
import fs from 'node:fs';
import { chromium } from 'playwright';

const PORT = process.env.PORT || 3000;
const GOV = 'https://data.gov.il/api/3/action/datastore_search?resource_id=053cea08-09bc-40ec-8f7a-156f0677aff3&q=';

// אתרי יצרנים. brand = מילות מפתח בשם היצרן (tozeret_nm) | by = מה מזינים באתר (plate / vin)
// אם אתר משנה מבנה - מתקנים כאן רק את url / input / button.
const SITES = [
  { name: 'Champion Motors', brand: ['אאודי','פולקסווגן','סקודה','סיאט','קופרה','AUDI','VOLKSWAGEN','SKODA','SEAT','CUPRA'], by: 'plate', url: 'https://www.championmotors.co.il/check-color/' },
  { name: 'Mazda',  brand: ['מזדה','MAZDA'], by: 'plate', url: 'https://www.mazda.co.il/color-code' },
  { name: 'Ford',   brand: ['פורד','FORD'],  by: 'plate', url: 'https://www.ford.co.il/%D7%91%D7%99%D7%A8%D7%95%D7%A8-%D7%A7%D7%95%D7%93-%D7%A6%D7%91%D7%A2/%D7%A9%D7%99%D7%A8%D7%95%D7%AA' },
  { name: 'Kia',    brand: ['קיה','KIA'],    by: 'plate', url: 'https://kia-israel.co.il/color-code' },
  { name: 'BMW',    brand: ['ב.מ.וו','ב מ וו','BMW','מיני','MINI'], by: 'vin', url: 'https://www.bmw.co.il/he/topics/offers-and-services/color-codes.html' },
];

const clean = s => String(s || '').replace(/\D/g, '');

// שלב 1: פרטי הרכב ומספר שלדה
async function vehicleInfo(plate) {
  const out = { plate, vin: null, maker: null, model: null, year: null, colorName: null, source: null };
  try {
    const r = await fetch(GOV + plate);
    const rec = (await r.json())?.result?.records?.[0];
    if (rec) {
      Object.assign(out, {
        vin: (rec.misgeret || '').trim() || null,
        maker: (rec.tozeret_nm || '').trim(), model: (rec.kinuy_mishari || rec.degem_nm || '').trim(),
        year: rec.shnat_yitzur, colorName: (rec.tzeva_rechev || '').trim(), source: 'data.gov.il',
      });
    }
  } catch {}
  return out;
}

// גיבוי: שליפת שלדה מאתר משומשת
async function vinFromMeshumeshet(browser, plate) {
  const page = await browser.newPage();
  try {
    await page.goto('https://meshumeshet.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('input[type="text"], input[type="search"], input:not([type])').first().fill(plate);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);
    const text = await page.locator('body').innerText();
    return text.match(/\b[A-HJ-NPR-Z0-9]{17}\b/)?.[0] || null;
  } catch { return null; } finally { await page.close(); }
}

// שלב 2: חיפוש באתר יצרן - ממלא את שדה הקלט הראשון, לוחץ חפש, וקורא את התשובה
async function askSite(browser, site, value) {
  const page = await browser.newPage();
  try {
    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('input[type="text"], input[type="search"], input:not([type]):not([type=hidden])').first().fill(value);
    const btn = page.getByRole('button', { name: /לבדיקה|חפש|בדוק|שלח|בירור|search/i }).first();
    if (await btn.count()) await btn.click(); else await page.keyboard.press('Enter');
    await page.waitForTimeout(6000);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const m = text.match(/(?:קוד\s*צבע|color\s*code)[^A-Za-z0-9א-ת]{0,6}([A-Z0-9]{2,6}\b)/i);
    return { site: site.name, code: m?.[1] || null, snippet: m ? null : text.slice(0, 250) };
  } catch (e) { return { site: site.name, code: null, error: e.message }; } finally { await page.close(); }
}

async function search(plate) {
  const info = await vehicleInfo(plate);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    if (!info.vin) { info.vin = await vinFromMeshumeshet(browser, plate); info.source = info.vin ? 'meshumeshet.com' : info.source; }
    const maker = (info.maker || '').toUpperCase();
    const site = SITES.find(s => s.brand.some(b => maker.includes(b.toUpperCase())));
    const answer = site ? await askSite(browser, site, site.by === 'vin' ? (info.vin || plate) : plate) : null;
    const links = info.vin ? {
      PartSouq: `https://partsouq.com/en/search/all?q=${info.vin}`,
      Amayama: `https://www.amayama.com/en/search?q=${info.vin}`,
    } : {};
    return { info, answer, links, unsupported: !site };
  } finally { await browser.close(); }
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/search') {
    const plate = clean(u.searchParams.get('plate'));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    if (plate.length < 5) return res.end(JSON.stringify({ error: 'מספר רישוי לא תקין' }));
    return res.end(JSON.stringify(await search(plate).catch(e => ({ error: e.message }))));
  }
  if (u.pathname === '/manifest.json') { res.writeHead(200, { 'Content-Type': 'application/manifest+json' }); return res.end(fs.readFileSync(new URL('./public/manifest.json', import.meta.url))); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(new URL('./public/index.html', import.meta.url)));
}).listen(PORT, () => console.log('http://localhost:' + PORT));
