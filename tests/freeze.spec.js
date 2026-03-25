const { test, expect, chromium } = require('@playwright/test');
const https = require('https');
const { authenticator } = require('otplib');

const [DISCORD_EMAIL, DISCORD_PASSWORD] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');
const DISCORD_2FA = process.env.DISCORD_2FA || '';

const TIMEOUT = 120000;

// 🛡️ 暴力清除广告 (连根拔起 Google Ads iframe)
async function killAllAds(page) {
    console.log('🛡️ 启动广告雷达，清除页面遮挡物...');
    try {
        await page.evaluate(() => {
            document.querySelectorAll('iframe').forEach(iframe => {
                if (iframe.id.includes('google') || iframe.src.includes('ads') || iframe.id.includes('vignette') || iframe.name.includes('google')) {
                    iframe.remove();
                }
            });
        });
        
        const adCloseSelectors = ['button[aria-label="Close"]', '.close-button', 'div[class*="ad"] button[class*="close"]'];
        for (const selector of adCloseSelectors) {
            const closeBtn = page.locator(selector).first();
            if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
                await closeBtn.click({ force: true });
                await page.waitForTimeout(500);
            }
        }
    } catch { }
}

// 📨 发送合并的 TG 消息
function sendTG(resultText, coinBalance) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        
        const msg = `🎮 FreezeHost 续期报告\n\n${resultText}\n\n💰 账户余额：${coinBalance} 金币\n\n官网地址：https://free.freezehost.pro/`;

        const req = https.request({
            hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST', headers: { 'Content-Type': 'application/json' },
        }, (res) => resolve());

        req.on('error', () => resolve());
        req.setTimeout(10000, () => { req.destroy(); resolve(); });
        req.write(JSON.stringify({ chat_id: TG_CHAT_ID, text: msg }));
        req.end();
    });
}

// ⏱️ 获取并解析网页上的剩余时间
async function getRemainingTime(page) {
    const text = await page.evaluate(() => document.getElementById('renewal-status-console')?.innerText.trim());
    if (!text) return { text: "获取失败", totalDays: 0 };
    
    const daysMatch = text.match(/(\d+(?:\.\d+)?)\s*day/i);
    const hoursMatch = text.match(/(\d+(?:\.\d+)?)\s*hour/i);
    
    const days = daysMatch ? parseInt(daysMatch[1]) : 0;
    const hoursRaw = hoursMatch ? parseFloat(hoursMatch[1]) : 0;
    const hours = Math.floor(hoursRaw);
    const minutes = Math.round((hoursRaw - hours) * 60);
    
    return {
        text: `${days}天 ${hours}小时 ${minutes}分钟`,
        totalDays: days + (hoursRaw / 24) // 转换为精确的小数天数，方便前后比对大小
    };
}

test('FreezeHost 多服务器自动续期', async () => {
    test.setTimeout(TIMEOUT); 
    if (!DISCORD_EMAIL || !DISCORD_PASSWORD) throw new Error('缺少 DISCORD_ACCOUNT');

    let proxyConfig = process.env.GOST_PROXY ? { server: process.env.GOST_PROXY } : undefined;
    const browser = await chromium.launch({ headless: true, proxy: proxyConfig });
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);
    
    let reportLines = []; 
    let coinBalance = "未知";

    try {
        console.log('🔑 访问并登录 FreezeHost...');
        await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });
        await page.click('span.text-lg:has-text("Login with Discord")');
        await page.locator('button#confirm-login').waitFor({ state: 'visible' });
        await page.click('button#confirm-login');

        await page.waitForURL(/discord\.com\/login/, { timeout: 30000 });
        await page.fill('input[name="email"]', DISCORD_EMAIL);
        await page.fill('input[name="password"]', DISCORD_PASSWORD);
        await page.click('button[type="submit"]');

        const twoFaInput = page.locator('input[autocomplete="one-time-code"], input[placeholder*="6"]');
        if (await twoFaInput.isVisible({ timeout: 5000 }).catch(() => false)) {
            console.log('🔐 自动填写 2FA...');
            const token = authenticator.generate(DISCORD_2FA.replace(/\s/g, ''));
            await twoFaInput.fill(token);
            await page.click('button[type="submit"]');
        }

        await page.waitForTimeout(5000);
        const authBtn = page.locator('button:has-text("Authorize"), button:has-text("授权")');
        if (await authBtn.isVisible().catch(() => false)) await authBtn.click();

        await page.waitForURL(/free\.freezehost\.pro\/dashboard/, { timeout: 30000 });
        console.log('✅ 登录成功，开始获取账户数据...');

        await page.waitForTimeout(4000);

        // 💰 抓取金币余额
        try {
            coinBalance = await page.evaluate(() => {
                const bodyText = document.body.innerText;
                const match1 = bodyText.match(/AVAILABLE BALANCE\s*([\d,]+)/i);
                const match2 = bodyText.match(/([\d,]+)\s*GLOBAL CURRENCY/i);
                if (match1) return match1[1];
                if (match2) return match2[1];
                return "未知";
            });
            console.log(`💰 当前金币余额：${coinBalance}`);
        } catch (e) { }

        // 🚀 提取服务器名称
        const servers = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href*="server-console"]'));
            return links.map((link, idx) => {
                let el = link;
                let cardText = '';
                while (el && el.tagName !== 'BODY') {
                    if (el.innerText && (el.innerText.includes('ID:') || el.innerText.includes('Node:'))) {
                        cardText = el.innerText;
                        break;
                    }
                    el = el.parentElement;
                }
                let name = `服务器-${idx + 1}`;
                if (cardText) {
                    const lines = cardText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                    if (lines.length > 0) name = lines[0];
                }
                return { name: name.toUpperCase(), url: link.href };
            });
        });

        if (servers.length === 0) throw new Error('未发现任何服务器链接');
        console.log(`✅ 共找到 ${servers.length} 台服务器，准备依次处理`);

        for (const srv of servers) {
            console.log(`\n▶️ 开始处理: [${srv.name}]`);
            await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(3000);

            // ⏱️ 1. 获取续期前的初始时间
            let preTime = await getRemainingTime(page);
            
            if (preTime.totalDays > 7) {
                reportLines.push(`${srv.name} : ⏳ 未到期 (剩余: ${preTime.text})`);
                console.log(`  ⏰ 剩余 ${preTime.text}，无需操作`);
                continue;
            }

            console.log(`  ✅ 准备续费 [${srv.name}] ...`);
            await killAllAds(page);

            // 2. 点击图一：外链小图标
            console.log(`  🔍 寻找并点击续期外链图标(图一)...`);
            const clickedIcon = await page.evaluate(() => {
                const icons = document.querySelectorAll('i.fa-external-link-alt');
                for (let icon of icons) {
                    let parent = icon.parentElement;
                    if (parent && parent.outerHTML.includes('reviewAction')) continue;
                    if (parent) {
                        parent.click();
                        return true;
                    }
                }
                return false;
            });

            if (clickedIcon) {
                console.log(`  ✅ 图一图标已点击，等待图二弹窗...`);
                await page.waitForTimeout(3000);
                await killAllAds(page);

                // 3. 弹窗处理：找到黄色的 RENEW INSTANCE 按钮并点击
                const renewBtn = page.locator('#renew-link-modal');
                await renewBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

                if (await renewBtn.isVisible()) {
                    const btnText = (await renewBtn.innerText()).trim();
                    if (btnText.toLowerCase().includes('renew instance')) {
                        console.log(`  📤 找到黄色按钮，执行物理点击！`);
                        await renewBtn.click({ force: true });
                        await page.waitForTimeout(6000); // 等待请求提交

                        // 快速判断是否有余额不足的报错
                        if (page.url().includes('err=CANNOTAFFORDRENEWAL')) {
                            reportLines.push(`${srv.name} : ❌ 余额不足 (需要 100 币)`);
                            continue;
                        }

                        // 🔄 4. 核心终极逻辑：无论跳到哪里，强行刷新回到服务器面板获取最新时间
                        console.log(`  🔄 重新加载页面，获取最新时间...`);
                        await page.goto(srv.url, { waitUntil: 'domcontentloaded' });
                        await page.waitForTimeout(4000);
                        
                        let postTime = await getRemainingTime(page);
                        
                        // 对比续期前后天数，只要最新时间比以前大，就是成功
                        if (postTime.totalDays > preTime.totalDays) {
                            reportLines.push(`${srv.name} : ✅ 成功续期 (最新剩余: ${postTime.text})`);
                            console.log(`  🎉 续费验证成功，最新剩余: ${postTime.text}`);
                        } else {
                            reportLines.push(`${srv.name} : ⚠️ 点击完成，但时间未增加 (当前: ${postTime.text})`);
                        }

                    } else {
                        reportLines.push(`${srv.name} : ⏳ 未到期 (按钮: ${btnText})`);
                    }
                } else {
                    reportLines.push(`${srv.name} : ⚠️ 弹窗未显示`);
                }
            } else {
                reportLines.push(`${srv.name} : ⚠️ 未找到续期图标`);
            }
        }

    } catch (e) {
        console.error(`❌ 致命错误: ${e.message}`);
        reportLines.push(`❌ 脚本运行异常: ${e.message}`);
    } finally {
        if (reportLines.length > 0) {
            await sendTG(reportLines.join('\n'), coinBalance);
        }
        await browser.close();
    }
});
