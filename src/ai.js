import puppeteer from 'puppeteer';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const arcadeAI = axios.create({
    baseURL: 'https://api.arcade.ai/v1',
    headers: {
        'Authorization': `Bearer ${process.env.ARCADE_AI_API_KEY}`,
        'Content-Type': 'application/json',
    },
});

export async function runQATest(url, instructions, options = {}) {
    console.log('Starting runQATest:', { url, instructions, options });
    
    if (!process.env.ARCADE_AI_API_KEY) {
        throw new Error('ARCADE_AI_API_KEY is not set in environment variables');
    }

    let browser;
    try {
        console.log('Launching Puppeteer browser...');
        browser = await puppeteer.launch({
            headless: 'new',
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', // macOS Chrome path
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-web-security',
                '--disable-features=site-per-process',
                '--no-first-run',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-client-side-phishing-detection',
                '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
            ],
            timeout: 120000, // 2 minutes
            protocolTimeout: 120000,
            pipe: true,
            dumpio: true
        });
        console.log('Browser launched successfully');

        console.log('Creating new page...');
        const page = await browser.newPage();
        console.log('Page created');

        if (options.userAgent === 'mobile') {
            console.log('Setting mobile user agent and viewport...');
            await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1');
            await page.setViewport({ width: 375, height: 812 });
        } else if (options.userAgent === 'tablet') {
            console.log('Setting tablet user agent and viewport...');
            await page.setUserAgent('Mozilla/5.0 (iPad; CPU OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1');
            await page.setViewport({ width: 768, height: 1024 });
        }

        console.log(`Navigating to ${url}...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        console.log('Navigation completed');

        // Handle cookie consent popup
        console.log('Checking for cookie consent popup...');
        const isPopupHandled = await handleCookiePopup(page);
        if (!isPopupHandled) {
            console.log('No cookie consent popup found or failed to handle');
        } else {
            console.log('Cookie consent popup handled');
            await page.waitForTimeout(1000); // Wait for popup to disappear
        }

        console.log(`Waiting for ${options.waitTime || 10} seconds...`);
        await page.waitForTimeout((options.waitTime || 10) * 1000);

        const screenshots = [];
        if (options.screenshots !== false) {
            console.log('Taking initial screenshot...');
            const screenshotPath = await takeScreenshot(page, 'initial');
            screenshots.push({
                id: 'initial',
                description: 'Initial page load',
                timestamp: new Date().toISOString(),
                path: screenshotPath,
            });
            console.log('Initial screenshot taken');
        }

        console.log('Analyzing page structure...');
        const pageAnalysis = await analyzePage(page);
        console.log('Page analysis completed');

        console.log('Processing test instructions...');
        const aiAnalysis = await processTestInstructions(instructions, pageAnalysis);
        console.log('Test instructions processed');

        console.log('Executing test actions...');
        const actionResults = await executeActions(page, aiAnalysis.actions, screenshots);
        console.log('Test actions executed');

        console.log('Verifying outcome...');
        const verification = await verifyOutcome(page, aiAnalysis.expectedOutcome, instructions, actionResults);
        const status = verification.success ? 'success' : 'failed';
        console.log('Outcome verified:', { status, message: verification.message });

        if (options.screenshots !== false) {
            console.log('Taking final screenshot...');
            const screenshotPath = await takeScreenshot(page, 'final');
            screenshots.push({
                id: 'final',
                description: `Final state after ${status} test`,
                timestamp: new Date().toISOString(),
                path: screenshotPath,
            });
            console.log('Final screenshot taken');
        }

        const results = {
            url,
            instructions,
            timestamp: new Date().toISOString(),
            status,
            message: verification.message,
            analysis: {
                pageTitle: await page.title(),
                pageStructure: pageAnalysis,
                aiInterpretation: aiAnalysis,
                taskExecution: {
                    stepsPerformed: actionResults.length,
                    successRate: calculateSuccessRate(actionResults),
                    findings: actionResults,
                },
            },
            screenshots,
            technicalDetails: {
                browser: 'Chrome/Chromium',
                viewport: page.viewport(),
                userAgent: await page.evaluate(() => navigator.userAgent),
            },
        };

        console.log('runQATest completed:', results);
        return results;

    } catch (error) {
        console.error('runQATest error:', {
            message: error.message,
            name: error.name,
            stack: error.stack,
            error: error
        });
        throw error;
    } finally {
        if (browser) {
            console.log('Closing browser...');
            await browser.close().catch(err => console.error('Browser close error:', err));
            console.log('Browser closed');
        }
    }
}

async function handleCookiePopup(page) {
    const generalSelectors = [
        'button[aria-label="Accept"], button[aria-label="Accept all"], button[aria-label="Agree"], button[aria-label="OK"], button[aria-label="Consent"]',
        '#cookie-consent-button, .accept-cookies, .btn-consent, .save-preference-btn'
    ].join(', ');

    const siteSpecificSelectors = {
        'whatismyip.com': 'button:contains("Accept & Close")',
        'google.com': 'button[aria-label="Accept all"], #L2AGLb'
    }[new URL(page.url()).hostname] || '';

    const allSelectors = [generalSelectors, siteSpecificSelectors].filter(s => s).join(', ');

    try {
        await page.waitForSelector(allSelectors, { timeout: 5000 });
        const button = await page.$(allSelectors);
        if (button) {
            await button.click();
            return true;
        }
        return false;
    } catch (error) {
        console.log('Cookie popup detection failed:', error.message);
        return false;
    }
}

async function analyzePage(page) {
    try {
        console.log('Evaluating page structure...');
        return await page.evaluate(() => {
            const elements = {
                forms: Array.from(document.querySelectorAll('form')).map(form => ({
                    id: form.id,
                    action: form.action,
                    method: form.method,
                    inputs: Array.from(form.querySelectorAll('input')).map(input => ({
                        type: input.type,
                        name: input.name,
                        id: input.id,
                        placeholder: input.placeholder,
                        required: input.required,
                    })),
                })),
                buttons: Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).map(btn => ({
                    type: btn.type || 'button',
                    text: btn.textContent.trim() || btn.value,
                    id: btn.id,
                    classes: Array.from(btn.classList),
                    ariaLabel: btn.getAttribute('aria-label') || ''
                })),
                links: Array.from(document.querySelectorAll('a')).map(link => ({
                    href: link.href,
                    text: link.textContent.trim(),
                    id: link.id,
                })),
                inputs: Array.from(document.querySelectorAll('input, textarea, select')).map(input => ({
                    type: input.type || input.tagName.toLowerCase(),
                    name: input.name,
                    id: input.id,
                    placeholder: input.placeholder,
                })),
                images: Array.from(document.querySelectorAll('img')).map(img => ({
                    src: img.src,
                    alt: img.alt,
                    id: img.id,
                })),
                ipElements: Array.from(document.querySelectorAll('[data-ip], .ip-address, [class*="ip"], p')).map(el => ({
                    text: el.textContent.trim(),
                    id: el.id,
                    classes: Array.from(el.classList),
                    tag: el.tagName.toLowerCase(),
                    dataIp: el.getAttribute('data-ip') || ''
                })),
                searchResults: Array.from(document.querySelectorAll('[role="listitem"], .g, .tF2Cxc')).map(result => ({
                    title: result.querySelector('h3')?.textContent.trim() || '',
                    url: result.querySelector('a')?.href || '',
                    snippet: result.querySelector('.VwiC3b, .IsZvec')?.textContent.trim() || ''
                })),
            };

            return {
                elements,
                documentStructure: {
                    title: document.title,
                    headings: Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).map(h => ({
                        level: h.tagName,
                        text: h.textContent.trim(),
                    })),
                    metaDescription: document.querySelector('meta[name="description"]')?.content,
                },
            };
        });
    } catch (error) {
        console.error('analyzePage error:', {
            message: error.message,
            name: error.name,
            stack: error.stack,
            error: error
        });
        throw new Error(`Page analysis failed: ${error.message}`);
    }
}

async function processTestInstructions(instructions, pageAnalysis) {
    const prompt = `
        You are an AI QA testing assistant for web applications. Your task is to interpret the user's test instructions and the page structure to generate a sequence of actions to perform the test. The instructions may involve extracting data (e.g., IP addresses), interacting with forms (e.g., searching), or capturing screenshots of specific states.

        User Instructions: "${instructions}"

        Page Analysis: ${JSON.stringify(pageAnalysis, null, 2)}

        Instructions:
        - Analyze the user's instructions to determine the test scenario (e.g., extracting an IP address, performing a search, capturing a screenshot).
        - Based on the page structure, identify the elements needed to perform the test.
        - For extraction tasks (e.g., IP address), use valid CSS selectors (e.g., '.ip-address', '[data-ip]', '#ipv4-head') and avoid jQuery-specific pseudo-selectors like ':contains'.
        - For dynamic content (e.g., IP addresses that load slowly), include a 'wait' action to ensure the element is visible and updated (not 'Detecting...').
        - For form interactions (e.g., search), identify input fields and submit buttons, and include actions to fill and submit the form.
        - For search tasks (e.g., Google search), extract results from elements like '.g' or '[role="listitem"]' and include their title, URL, and snippet.
        - For screenshot-only tasks, include a 'screenshot' action with a descriptive ID and description.
        - For actions like signing up, generate test credentials (e.g., email: testuser+timestamp@example.com, password: Test123!).
        - Return a JSON object with:
          - "interpretation": A brief explanation of the test scenario.
          - "actions": An array of actions to perform, each with:
            - "type": Action type (click, fill, extract, navigate, wait, screenshot, submit).
            - "target": Valid CSS selector or 'page' for screenshots.
            - "value": Value for fill/submit actions, expected data type for extract (e.g., 'text'), or null.
            - "description": Human-readable action description.
          - "expectedOutcome": Expected result (e.g., "IP address extracted", "Search results returned", "Screenshot captured").
        - Ensure actions are specific, executable, and based on the page structure.

        Examples:
        1. IP address extraction:
        {
            "interpretation": "Extract the IP address from the website",
            "actions": [
                {
                    "type": "wait",
                    "target": "#ipv4-head",
                    "value": "visible",
                    "description": "Wait for the IPv4 address to be visible"
                },
                {
                    "type": "extract",
                    "target": "#ipv4-head",
                    "value": "text",
                    "description": "Extract IPv4 address from #ipv4-head"
                }
            ],
            "expectedOutcome": "IP address is extracted in IPv4 or IPv6 format"
        }
        2. Google search:
        {
            "interpretation": "Search for 'bob' on Google and extract results",
            "actions": [
                {
                    "type": "fill",
                    "target": "input[name='q']",
                    "value": "bob",
                    "description": "Enter 'bob' in the search input"
                },
                {
                    "type": "submit",
                    "target": "form[action='/search']",
                    "value": null,
                    "description": "Submit the search form"
                },
                {
                    "type": "wait",
                    "target": ".g",
                    "value": "visible",
                    "description": "Wait for search results to load"
                },
                {
                    "type": "extract",
                    "target": ".g",
                    "value": "list",
                    "description": "Extract search results (title, URL, snippet)"
                }
            ],
            "expectedOutcome": "Search results for 'bob' are extracted with titles, URLs, and snippets"
        }
        3. Screenshot of page state:
        {
            "interpretation": "Capture a screenshot of the page after loading",
            "actions": [
                {
                    "type": "screenshot",
                    "target": "page",
                    "value": "loaded_page",
                    "description": "Capture screenshot of the loaded page"
                }
            ],
            "expectedOutcome": "Screenshot of the page is captured"
        }
    `;

    try {
        console.log('Calling Arcade AI API for instruction processing...');
        const response = await arcadeAI.post('/chat/completions', {
            model: 'arcade-gpt',
            messages: [
                {
                    role: 'system',
                    content: 'You are a web QA testing expert. Generate precise actions for automated testing based on user instructions and page structure.',
                },
                { role: 'user', content: prompt },
            ],
            temperature: 0.3,
        });

        const result = JSON.parse(response.data.choices[0].message.content);
        console.log('Arcade AI response:', result);
        return result;
    } catch (error) {
        console.error('processTestInstructions error:', {
            message: error.message,
            name: error.name,
            stack: error.stack,
            error: error,
            response: error.response?.data
        });
        throw new Error(`Failed to process test instructions with Arcade AI: ${error.message}`);
    }
}

async function executeActions(page, actions, screenshots) {
    const results = [];

    for (const action of actions) {
        try {
            console.log(`Executing action: ${action.type} on ${action.target}`);

            switch (action.type) {
                case 'click':
                    await page.waitForSelector(action.target, { timeout: 5000 });
                    await page.click(action.target);
                    results.push({ action, status: 'success' });
                    break;
                case 'fill':
                case 'type':
                    await page.waitForSelector(action.target, { timeout: 5000 });
                    await page.type(action.target, action.value);
                    results.push({ action, status: 'success' });
                    break;
                case 'select':
                    await page.waitForSelector(action.target, { timeout: 5000 });
                    await page.select(action.target, action.value);
                    results.push({ action, status: 'success' });
                    break;
                case 'submit':
                    await page.waitForSelector(action.target, { timeout: 5000 });
                    await page.evaluate(selector => {
                        document.querySelector(selector).submit();
                    }, action.target);
                    results.push({ action, status: 'success' });
                    break;
                case 'extract':
                    if (action.value === 'list') {
                        const extractedData = await page.evaluate(selector => {
                            return Array.from(document.querySelectorAll(selector)).map(el => ({
                                title: el.querySelector('h3')?.textContent.trim() || '',
                                url: el.querySelector('a')?.href || '',
                                snippet: el.querySelector('.VwiC3b, .IsZvec')?.textContent.trim() || ''
                            }));
                        }, action.target);
                        results.push({ action, status: extractedData.length ? 'success' : 'failed', data: extractedData });
                    } else {
                        let extractedData = null;
                        if (action.target.includes('ip')) {
                            extractedData = await pollForContent(page, action.target, 30000);
                        } else {
                            extractedData = await page.evaluate(selector => {
                                const element = document.querySelector(selector);
                                return element ? element.textContent.trim() : null;
                            }, action.target);
                        }
                        results.push({ action, status: extractedData ? 'success' : 'failed', data: extractedData });
                    }
                    break;
                case 'wait':
                    if (action.value === 'visible') {
                        await page.waitForSelector(action.target, { visible: true, timeout: 10000 });
                        results.push({ action, status: 'success' });
                    } else {
                        await page.waitForTimeout(action.value || 1000);
                        results.push({ action, status: 'success' });
                    }
                    break;
                case 'navigate':
                    await page.goto(action.target, { waitUntil: 'networkidle2' });
                    results.push({ action, status: 'success' });
                    break;
                case 'screenshot':
                    const screenshotPath = await takeScreenshot(page, action.value || 'action');
                    screenshots.push({
                        id: action.value || 'action',
                        description: action.description,
                        timestamp: new Date().toISOString(),
                        path: screenshotPath
                    });
                    results.push({ action, status: 'success', data: screenshotPath });
                    break;
                default:
                    results.push({ action, status: 'skipped', reason: 'Unknown action type' });
            }

            await page.waitForTimeout(500);
        } catch (error) {
            console.error(`executeActions error for ${action.type}:`, {
                message: error.message,
                name: error.name,
                stack: error.stack,
                error: error
            });
            results.push({ action, status: 'failed', error: error.message });
        }
    }

    return results;
}

async function pollForContent(page, selector, timeout = 30000) {
    const startTime = Date.now();
    console.log(`Polling for content on ${selector}...`);
    
    while (Date.now() - startTime < timeout) {
        const content = await page.evaluate(sel => {
            const element = document.querySelector(sel);
            return element ? element.textContent.trim() : null;
        }, selector);

        if (content && !content.includes('Detecting...') && content !== '') {
            console.log(`Content found: ${content}`);
            return content;
        }

        console.log(`Content still 'Detecting...' or empty, waiting...`);
        await page.waitForTimeout(2000);
    }

    console.error(`Polling timed out after ${timeout}ms for ${selector}`);
    return null;
}

async function verifyOutcome(page, expectedOutcome, instructions, actionResults) {
    try {
        console.log('Verifying test outcome...');
        const pageContent = await page.evaluate(() => document.body.textContent.toLowerCase());
        const successIndicators = ['welcome', 'success', 'account created', 'signed up', 'thank you', 'ip address'];
        const errorIndicators = ['error', 'failed', 'invalid', 'try again'];

        let success = false;
        let message = 'Test completed';

        const extractResults = actionResults.filter(result => result.action.type === 'extract');
        const screenshotResults = actionResults.filter(result => result.action.type === 'screenshot');

        const ipRegex = {
            ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
            ipv6: /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/
        };

        if (instructions.toLowerCase().includes('ip address')) {
            const ipData = extractResults.find(r => r.data && (r.action.target.includes('ipv4') || r.action.target.includes('ip')));
            if (ipData && ipData.data) {
                const ipText = ipData.data.replace(/My Public IPv[4|6]:/, '').trim();
                if (ipRegex.ipv4.test(ipText) || ipRegex.ipv6.test(ipText)) {
                    success = true;
                    message = `Test successful: IP address ${ipText} extracted`;
                } else {
                    success = false;
                    message = `Test failed: Extracted data '${ipText}' is not a valid IP address`;
                }
            } else {
                success = false;
                message = 'Test failed: No valid IP address extracted';
            }
        } else if (instructions.toLowerCase().includes('search')) {
            const searchData = extractResults.find(r => r.action.value === 'list');
            if (searchData && searchData.data && searchData.data.length > 0) {
                success = true;
                message = `Test successful: ${searchData.data.length} search results extracted`;
            } else {
                success = false;
                message = 'Test failed: No search results extracted';
            }
        } else if (instructions.toLowerCase().includes('screenshot')) {
            if (screenshotResults.length > 0) {
                success = true;
                message = `Test successful: ${screenshotResults.length} screenshots captured`;
            } else {
                success = false;
                message = 'Test failed: No screenshots captured';
            }
        } else if (extractResults.length > 0 && extractResults.every(r => r.status === 'success' && r.data)) {
            success = true;
            message = 'Test successful: All extractions completed';
        } else if (successIndicators.some(indicator => pageContent.includes(indicator))) {
            success = true;
            message = 'Test successful: Expected outcome achieved (based on page content)';
        } else if (errorIndicators.some(indicator => pageContent.includes(indicator))) {
            success = false;
            message = 'Test failed: Error detected on page';
        } else {
            const prompt = `
                Verify if the test outcome matches the expected result.
                Instructions: "${instructions}"
                Expected Outcome: "${expectedOutcome}"
                Current Page Title: "${await page.title()}"
                Extracted Data: ${JSON.stringify(extractResults.map(r => r.data))}
                Page Content Sample: "${pageContent.slice(0, 500)}..."
                
                Return a JSON object with:
                - "success": Boolean indicating if the test succeeded
                - "message": Explanation of the verification result
            `;

            console.log('Calling Arcade AI API for outcome verification...');
            const response = await arcadeAI.post('/chat/completions', {
                model: 'arcade-gpt',
                messages: [
                    { role: 'system', content: 'You are a web QA testing expert. Verify test outcomes based on page content and extracted data.' },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.3,
            });

            const verification = JSON.parse(response.data.choices[0].message.content);
            console.log('Arcade AI verification response:', verification);
            success = verification.success;
            message = verification.message;
        }

        return { success, message };
    } catch (error) {
        console.error('verifyOutcome error:', {
            message: error.message,
            name: error.name,
            stack: error.stack,
            error: error,
            response: error.response?.data
        });
        return { success: false, message: `Verification failed: ${error.message}` };
    }
}

async function takeScreenshot(page, name) {
    try {
        console.log(`Taking screenshot: ${name}`);
        const timestamp = Date.now();
        const filename = `screenshot_${name}_${timestamp}.png`;
        const filepath = join(process.cwd(), 'public', 'screenshots', filename);

        await mkdir(join(process.cwd(), 'public', 'screenshots'), { recursive: true });
        await page.screenshot({ path: filepath, fullPage: true });

        return `/screenshots/${filename}`;
    } catch (error) {
        console.error('takeScreenshot error:', {
            message: error.message,
            name: error.name,
            stack: error.stack,
            error: error
        });
        throw new Error(`Failed to take screenshot: ${error.message}`);
    }
}

function calculateSuccessRate(results) {
    const successful = results.filter(r => r.status === 'success').length;
    return `${Math.round((successful / results.length) * 100)}%`;
}