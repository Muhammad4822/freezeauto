const { test, expect, chromium } = require('@playwright/test');
const https = require('https');
const { authenticator } = require('otplib'); // 引入 2FA 计算库

const [DISCORD_EMAIL, DISCORD_PASSWORD] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');
const DISCORD_2FA = process.env.DISCORD_2FA || ''; // 读取 2FA 密钥

// 延长超时到 2 分钟，防止网速慢导致强制掐断
const TIMEOUT = 120000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }

        const msg = [
            `🎮 FreezeHost 续期通知`,
            `🕐 运行时间: ${nowStr()}`,
            `🖥 服务器: FreezeHost Free`,
            `📊 续期结果: ${result}`,
        ].join('\n');

        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            if (res.statusCode === 200) {
                console.log('📨 TG 推送成功');
            } else {
                console.log(`⚠️ TG 推送失败：HTTP ${res.statusCode}`);
            }
            resolve();
        });

        req.on('error', (e) => {
            console.log(`⚠️ TG 推送异常：${e.message}`);
            resolve();
        });

        req.setTimeout(15000, () => {
            console.log('⚠️ TG 推送超时');
            req.destroy();
            resolve();
        });

        req.write(body);
        req.end();
    });
}

// 🛡️ 尝试关闭可能的广告弹窗
async function tryCloseAds(page) {
    console.log('🔍 尝试关闭可能的广告弹窗...');
    const adCloseSelectors = [
        'button[aria-label="Close"]', // 通用关闭按钮
        '.close-button',             // 常见类名
        'div[class*="ad"] button[class*="close"]', // 针对广告容器内的关闭
    ];

    for (const selector of adCloseSelectors) {
        try {
            const closeBtn = page.locator(selector).first();
            if (await closeBtn.isVisible({ timeout: 1000 })) {
                console.log(`  🔘 找到广告关闭按钮: ${selector}`);
                await closeBtn.click();
                await page.waitForTimeout(500); // 等待关闭动画
            }
        } catch { /* 忽略错误 */ }
    }
}

async function handleOAuthPage(page) {
    console.log(`  📄 当前 URL: ${page.url()}`);
    await page.waitForTimeout(3000);

    const selectors = [
        'button:has-text("Authorize")',
        'button:has-text("授权")',
        'button[type="submit"]',
        'div[class*="footer"] button',
        'button[class*="primary"]',
    ];

    for (let i = 0; i < 8; i++) {
        console.log(`  🔄 第 ${i + 1} 次尝试，URL: ${page.url()}`);

        if (!page.url().includes('discord.com')) {
            console.log('  ✅ 已离开 Discord');
            return;
        }

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);

        for (const selector of selectors) {
            try {
                const btn = page.locator(selector).last();
                const visible = await btn.isVisible();
                if (!visible) continue;

                const text = (await btn.innerText()).trim();
                console.log(`  🔘 找到按钮: "${text}" (${selector})`);

                if (text.includes('取消') || text.toLowerCase().includes('cancel') ||
                    text.toLowerCase().includes('deny')) continue;

                const disabled = await btn.isDisabled();
                if (disabled) {
                    console.log('  ⏳ 按钮 disabled，等待...');
                    break;
                }

                await btn.click();
                console.log(`  ✅ 已点击: "${text}"`);
                await page.waitForTimeout(2000);

                if (!page.url().includes('discord.com')) {
                    console.log('  ✅ 授权成功，已跳转');
                    return;
                }
                break;
            } catch { continue; }
        }

        await page.waitForTimeout(2000);
    }

    console.log(`  ⚠️ handleOAuthPage 结束，URL: ${page.url()}`);
}

test('FreezeHost 自动续期', async () => {
    // 🚀 核心修复：把总体超时延长到 2 分钟，防止网速慢导致强制掐断
    test.setTimeout(TIMEOUT); 

    if (!DISCORD_EMAIL || !DISCORD_PASSWORD) {
        throw new Error('❌ 缺少 DISCORD_ACCOUNT，格式: email,password');
    }

    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        try {
            const http = require('http');
            await new Promise((resolve, reject) => {
                const req = http.request({ host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 }, () => resolve());
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.end();
            });
            proxyConfig = { server: process.env.GOST_PROXY };
            console.log('🛡️ 本地代理连通，使用 GOST 转发');
        } catch {
            console.log('⚠️ 本地代理不可达，降级为直连');
        }
    }

    console.log('🔧 启动浏览器...');
    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);
    console.log('🚀 浏览器就绪！');

    try {
        // ── 出口 IP 验证 ──────────────────────────────────────
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            const body = await res.text();
            const ip = JSON.parse(body).ip || body;
            const masked = ip.replace(/(\d+\.\d+\.\d+\.)\d+/, '$1xx');
            console.log(`✅ 出口 IP 确认：${masked}`);
        } catch {
            console.log('⚠️ IP 验证超时，跳过');
        }

        // ── 登录 ──────────────────────────────────────────────
        console.log('🔑 打开 FreezeHost 登录页...');
        await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });

        console.log('📤 点击 Login with Discord...');
        await page.click('span.text-lg:has-text("Login with Discord")');

        console.log('⏳ 等待服务条款弹窗...');
        const confirmBtn = page.locator('button#confirm-login');
        await confirmBtn.waitFor({ state: 'visible' });
        await confirmBtn.click();
        console.log('✅ 已接受服务条款');

        console.log('⏳ 等待跳转 Discord 登录页...');
        await page.waitForURL(/discord\.com\/login/);

        console.log('✏️ 填写账号密码...');
        await page.fill('input[name="email"]', DISCORD_EMAIL);
        await page.fill('input[name="password"]', DISCORD_PASSWORD);

        console.log('📤 提交登录请求...');
        await page.click('button[type="submit"]');
        await page.waitForTimeout(2000);

        // —— 2FA / 验证码逻辑 (修复图一的开头报错) ——
        const twoFaInput = page.locator('input[autocomplete="one-time-code"], input[placeholder*="6"]');
        if (await twoFaInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log("🔐 触发了 2FA，正在生成动态验证码...");
            if (!DISCORD_2FA) {
                await sendTG('❌ 登录失败：触发了 2FA，但 GitHub 未配置 DISCORD_2FA 密钥');
                throw new Error('❌ 缺少 2FA 密钥');
            }
            const token = authenticator.generate(DISCORD_2FA.replace(/\s+/g, '')); // 自动去除密钥里的空格
            await twoFaInput.fill(token);
            await page.click('button[type="submit"]');
            await page.waitForTimeout(3000);
            console.log("✅ 2FA 填写并提交完成");
        }

        if (/discord\.com\/login/.test(page.url())) {
            let err = '账密错误或触发了复杂的图形验证码';
            try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
            await sendTG(`❌ Discord 登录失败：${err}`);
            throw new Error(`❌ Discord 登录失败: ${err}`);
        }

        // ── OAuth 授权 ────────────────────────────────────────
         console.log('⏳ 等待 OAuth 授权...');
         try {
             await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
             console.log('🔍 进入 OAuth 授权页，处理中...');
             await page.waitForTimeout(2000);
             
             if (page.url().includes('discord.com')) {
                 await handleOAuthPage(page);
             } else {
                 console.log('✅ 已自动完成授权，无需手动点击');
             }
             
             await page.waitForURL(/free\.freezehost\.pro/, { timeout: 15000 });
             console.log(`✅ 已离开 Discord，当前：${page.url()}`);
         } catch {
             console.log(`✅ 静默授权或已跳转，当前：${page.url()}`);
         }

        // ── 确认到达 Dashboard ────────────────────────────────
        console.log('⏳ 确认到达 Dashboard...');
        try {
            await page.waitForURL(
                url => url.includes('/callback') || url.includes('/dashboard'),
                { timeout: 10000 }
            );
        } catch { /* 可能已经在 dashboard */ }

        if (page.url().includes('/callback')) {
            await page.waitForURL(/free\.freezehost\.pro\/dashboard/);
        }

        if (!page.url().includes('/dashboard')) {
            throw new Error(`❌ 未到达 Dashboard，当前 URL: ${page.url()}`);
        }
        console.log(`✅ 登录成功！当前：${page.url()}`);

        // ── 进入 Server Console ───────────────────────────────
        console.log('🔍 查找 Manage 按钮...');
        await page.waitForTimeout(3000);

        const serverUrl = await page.evaluate(() => document.querySelector('a[href*="server-console"]')?.href);

        if (!serverUrl) {
            throw new Error('❌ 未找到 server-console 链接');
        }

        console.log(`✅ 找到链接：${serverUrl}`);
        await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
        console.log(`✅ 已跳转到 Server Console: ${page.url()}`);

        // ── 检查剩余时间 ───────────────────────
        console.log('🔍 读取续期状态...');
        await page.waitForTimeout(3000);

        const renewalStatusText = await page.evaluate(() => document.getElementById('renewal-status-console')?.innerText.trim());

        console.log(`📋 续期状态：${renewalStatusText}`);

        if (renewalStatusText) {
            const daysMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*day/i);
            const remainingDays = daysMatch ? parseFloat(daysMatch[1]) : null;

            if (remainingDays !== null) {
                console.log(`⏳ 剩余天数：${remainingDays}`);
                if (remainingDays > 7) {
                    const msg = `⏰ 剩余 ${remainingDays} 天，无需续期（需 ≤7 天才续期）`;
                    console.log(msg);
                    await sendTG(msg);
                    return;
                }
                console.log(`✅ 剩余 ${remainingDays} 天，需要续期，继续操作...`);
            } else {
                console.log('⚠️ 无法解析剩余天数，尝试继续续期...');
            }
        } else {
            console.log('⚠️ 未找到 renewal-status-console，尝试继续续期...');
        }

        // —— 🛡️ 在点击图标前尝试关闭广告 ——
        await tryCloseAds(page);

        // ── 🚀 核心修复：点击外链图标并正确等待弹窗 ──
        console.log('🔍 查找真正可见的外链图标按钮 (图一)...');
        // 🚀 使用过滤精准过滤掉隐藏的 Review 弹窗按钮，只找页面上真正可见的图标。
        const visibleParent = page.locator('i.fa-external-link-alt').locator('xpath=..').filter({ state: 'visible' }).first();
        await visibleParent.waitFor({ state: 'visible', timeout: 20000 });
        
        await visibleParent.hover();
        console.log('✅ 已 hover 父元素，等待 CSS 动画显现...');
        await page.waitForTimeout(1000);
        await visibleParent.locator('i.fa-external-link-alt').click({ force: true });
        console.log('✅ 已点击外链图标，等待弹窗加载...');
        await page.waitForTimeout(2000);

        // —— 🛡️ 点击图标后再次尝试关闭广告 (处理用户提到的广告干扰) ——
        await tryCloseAds(page);

        // —— 🚀 核心修复：精准查找弹窗内的 RENEW INSTANCE 按钮 (图二) ——
        console.log('🔍 等待弹窗加载并查找 RENEW INSTANCE 按钮...');
        const renewModalBtn = page.locator('#renew-link-modal'); // 使用 ID 确保特异性
        await renewModalBtn.waitFor({ state: 'visible', timeout: 30000 }); // 增加超时给加载和广告处理时间

        const btnText = (await renewModalBtn.innerText()).trim();
        console.log(`📋 续期按钮文字："${btnText}"`);

        if (!btnText.toLowerCase().includes('renew instance')) {
            const msg = `⏰ 尚未到续期时间（按钮状态：${btnText}）`;
            console.log(msg);
            await sendTG('⏰ 尚未到续期时间，今日已续期或暂不需要续期');
            return;
        }

        // —— 🚀 核心修复：直接点击 RENEW INSTANCE 按钮，移除了 page.goto 跳转 ——
        console.log('📤 点击 RENEW INSTANCE 按钮...');
        await renewModalBtn.click();
        console.log('✅ 已点击，等待续期结果页...');

        console.log('⏳ 等待续期结果跳转...');
        await page.waitForURL(
            url => url.toString().includes('/dashboard') || url.toString().includes('/server-console'),
            { timeout: 60000 }
        );
        const finalUrl = page.url();

        // ── 结果判断 ──────────────────────────────────────────
        if (finalUrl.includes('success=RENEWED')) {
            console.log('🎉 续期成功！');
            await sendTG('✅ 续期成功！');
            expect(finalUrl).toContain('success=RENEWED');
        } else if (finalUrl.includes('err=CANNOTAFFORDRENEWAL')) {
            console.log('⚠️ 余额不足，无法续期');
            await sendTG('⚠️ 余额不足，请前往挂机页面赚取金币');
            test.skip(true, '余额不足');
        } else if (finalUrl.includes('err=TOOEARLY')) {
            console.log('⏰ 尚未到续期时间');
            await sendTG('⏰ 尚未到续期时间，今日已续期或暂不需要续期');
        } else {
            console.log(`⚠️ 续期结果未知：${finalUrl}`);
            await sendTG(`⚠️ 续期结果未知，请人工检查`);
            throw new Error('续期结果未知，URL: ' + finalUrl);
        }

    } catch (e) {
        if (!e.message?.includes('余额不足')) {
            await sendTG(`❌ 脚本异常：${e.message}`);
        }
        throw e;

    } finally {
        await browser.close();
    }
});
