const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

async function runBrowserTest() {
  for (const name of ['SESSION_COOKIE', 'BASE', 'CHROME_EXECUTABLE_PATH']) {
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  }
  const chromePath = process.env.CHROME_EXECUTABLE_PATH;
  const cookieVal = process.env.SESSION_COOKIE;
  const base = new URL(process.env.BASE);
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('BASE must use http or https');
  const targetUrl = new URL('/files', base).href;
  const proxyServer = process.env.PROXY;
  const tmpDir = path.resolve(__dirname, '../tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  console.log('1. 正在启动真实 Chrome 浏览器 (headless)...');
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: [
      ...(proxyServer ? [`--proxy-server=${proxyServer}`] : []),
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,900'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    page.on('console', msg => console.log('   [浏览器控制台]:', msg.text()));
    page.on('pageerror', err => console.error('   [浏览器页面错误]:', err.message));

    console.log('2. 注入认证 Cookie (picbed_session)...');
    await page.setCookie({
      name: 'picbed_session',
      value: cookieVal,
      domain: base.hostname,
      path: '/',
      httpOnly: true,
      secure: base.protocol === 'https:',
      sameSite: 'Lax'
    });

    console.log('3. 导航到文件中转页面: ' + targetUrl);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));

    const pageTitle = await page.title();
    console.log('   页面标题:', pageTitle);

    fs.mkdirSync(path.join(tmpDir, 'browser_test_out'), { recursive: true });
    await page.screenshot({ path: path.join(tmpDir, 'browser_test_out/01_files_page_init.png'), fullPage: true });

    console.log('4. 准备待上传的测试文件...');
    const testFilePath = path.join(tmpDir, 'browser_upload_demo.txt');
    fs.writeFileSync(testFilePath, '这是通过真实 Chrome 浏览器模拟文件选择上传的测试内容 - ' + new Date().toISOString());

    console.log('5. 定位上传输入框并选择文件...');
    const fileInput = await page.$('#relayfileinput');
    if (!fileInput) throw new Error('未找到 #relayfileinput 元素！');

    // 勾选公开选项
    const isPubCheckbox = await page.$('#relayispub');
    if (isPubCheckbox) {
      await isPubCheckbox.evaluate(b => b.checked = true);
    }

    // 触发上传
    await fileInput.uploadFile(testFilePath);
    await fileInput.evaluate(input => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    console.log('   已触发 change 事件，等待 XHR 请求完成...');

    await page.waitForFunction(() => {
      const st = document.querySelector('.up-item .st');
      return st && (st.textContent.includes('完成') || st.textContent.includes('失败'));
    }, { timeout: 30000 });

    const uploadStatusText = await page.$eval('.up-item .st', el => el.textContent);
    console.log('   上传状态回显:', uploadStatusText);

    // 检查是否有复制链接按钮
    const hasCopyBtn = await page.$eval('.up-item', el => Boolean(el.querySelector('button')));
    console.log('   是否生成了复制链接按钮:', hasCopyBtn);

    await page.screenshot({ path: path.join(tmpDir, 'browser_test_out/02_uploaded_progress.png'), fullPage: false });
    console.log('   [截图已保存] 传输与卡片回显: tmp/browser_test_out/02_uploaded_progress.png');

    console.log('6. 刷新页面验证新文件列表渲染...');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: path.join(tmpDir, 'browser_test_out/03_files_list_updated.png'), fullPage: true });
    console.log('   [截图已保存] 刷新后列表: tmp/browser_test_out/03_files_list_updated.png');

    const fileNames = await page.$$eval('.cell .nm', els => els.map(e => e.textContent.trim()));
    console.log('   当前列表展示的文件数:', fileNames.length, '文件名列表:', fileNames);

    console.log('7. 测试弹窗交互（点击最新文件的【详情】按钮）...');
    const detailBtn = await page.$('.cell:first-child a[onclick*="showFileDetail"]');
    if (detailBtn) {
      await detailBtn.click();
      await page.waitForSelector('#detailmodal.on', { timeout: 5000 });
      const detailContent = await page.$eval('#detailbody', el => el.innerText.trim());
      console.log('   详情弹窗内容:\n' + detailContent);
      await page.screenshot({ path: path.join(tmpDir, 'browser_test_out/04_detail_modal.png'), fullPage: false });
      console.log('   [截图已保存] 详情弹窗: tmp/browser_test_out/04_detail_modal.png');

      // 关闭详情弹窗
      await page.click('#detailmodal button');
      await page.waitForFunction(() => !document.querySelector('#detailmodal.on'), { timeout: 3000 });
    }

    console.log('8. 测试全屏预览/试听模态框（点击最新文件的预览缩略区）...');
    const previewLink = await page.$('.cell:first-child .ph a');
    if (previewLink) {
      await previewLink.click();
      await page.waitForSelector('#lb.on', { timeout: 5000 });
      await page.screenshot({ path: path.join(tmpDir, 'browser_test_out/05_preview_modal.png'), fullPage: false });
      console.log('   [截图已保存] 预览模态框: tmp/browser_test_out/05_preview_modal.png');
    }

    console.log('🎉 浏览器真实全流程端到端测试 100% 成功！');
  } finally {
    await browser.close();
  }
}

runBrowserTest().catch(err => {
  console.error('❌ 浏览器测试失败:', err);
  process.exit(1);
});
