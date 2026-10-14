const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const crypto = require('crypto');
const readline = require('readline');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
require('dotenv').config();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

const SESSION_FILE = './vnpay_session.json';

function generatePKCE() {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    return { codeVerifier, codeChallenge };
}

function extractKcData(html) {
    const actionMatch = html.match(/"loginAction":\s*"([^"]+)"/);
    const pageIdMatch = html.match(/kcContext\.pageId\s*=\s*"([^"]+)"/);
    
    let errorMessage = null;
    const errMatch1 = html.match(/<span[^>]*class="[^"]*kc-feedback-text[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const errMatch2 = html.match(/<div[^>]*class="[^"]*alert-error[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const errMatch3 = html.match(/"errorMessage"\s*:\s*"([^"]+)"/i);
    
    if (errMatch1) errorMessage = errMatch1[1].replace(/<[^>]*>?/gm, '').trim();
    else if (errMatch2) errorMessage = errMatch2[1].replace(/<[^>]*>?/gm, '').trim();
    else if (errMatch3) errorMessage = errMatch3[1];

    return {
        loginAction: actionMatch ? actionMatch[1] : null,
        pageId: pageIdMatch ? pageIdMatch[1] : null,
        errorMessage: errorMessage
    };
}

function getPhoneFromToken(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf-8'));
        return payload.phone || payload.preferred_username;
    } catch (e) {
        return null;
    }
}

function parseDateInput(value, fieldName) {
    const matches = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const date = matches
        ? new Date(`${matches[3]}-${matches[2]}-${matches[1]}T00:00:00`)
        : new Date('invalid');
    if (!matches || Number.isNaN(date.getTime()) ||
        date.getFullYear() !== Number(matches[3]) ||
        date.getMonth() + 1 !== Number(matches[2]) ||
        date.getDate() !== Number(matches[1])) {
        throw new Error(`${fieldName} phải có định dạng DD/MM/YYYY.`);
    }
    return date;
}

function toVnpayDateTime(value, endOfDay = false) {
    return `${value} ${endOfDay ? '23:59:59' : '00:00:00'}`;
}

function formatVnd(amount) {
    return `${Number(amount || 0).toLocaleString('vi-VN')} VND`;
}

async function selectFromList(items, title, formatItem) {
    console.log(`\n${title}`);
    items.forEach((item, index) => {
        console.log(`${index + 1}. ${formatItem(item)}`);
    });

    while (true) {
        const choice = Number(await askQuestion('Chọn số thứ tự: '));
        if (Number.isInteger(choice) && choice >= 1 && choice <= items.length) {
            return items[choice - 1];
        }
        console.log('❌ Lựa chọn không hợp lệ.');
    }
}

function getTransactions(response) {
    const transactions = response?.data?.transactionPagerDTOS;
    if (!Array.isArray(transactions)) {
        throw new Error('Response lịch sử giao dịch không có data.transactionPagerDTOS.');
    }
    return transactions;
}

function printTransactions(transactions, pageNumber) {
    if (transactions.length === 0) {
        console.log('\nKhông có giao dịch trong khoảng thời gian đã chọn.');
        return;
    }

    console.log(`\nTrang ${pageNumber} - ${transactions.length} giao dịch:`);
    transactions.forEach((transaction, index) => {
        console.log(
            `${index + 1}. ${transaction.transactionMappingDate || 'Không rõ ngày'} | ` +
            `${formatVnd(transaction.amountAfterDiscount)} | ` +
            `${transaction.customerFullName || 'Không rõ khách hàng'} | ` +
            `ID: ${transaction.id} | ${transaction.status === 1 ? 'Thành công' : `Trạng thái ${transaction.status}`}`
        );
    });
}

function printTransactionDetail(transaction) {
    console.log('\n==========================================');
    console.log('CHI TIẾT GIAO DỊCH');
    console.log('==========================================');
    console.log(`ID: ${transaction.id || 'N/A'}`);
    console.log(`Thời gian: ${transaction.createDate || transaction.transactionMappingDate || 'N/A'}`);
    console.log(`Số tiền: ${formatVnd(transaction.amountAfterDiscount)}`);
    console.log(`Khách hàng: ${transaction.customerFullName || 'N/A'}`);
    console.log(`Số điện thoại: ${transaction.customerMobile || 'N/A'}`);
    console.log(`Mã hóa đơn: ${transaction.billNumber || 'N/A'}`);
    console.log(`Mã ngân hàng: ${transaction.bankCode || 'N/A'}`);
    console.log(`Trạng thái: ${transaction.status === 1 ? 'Thành công' : transaction.status ?? 'N/A'}`);
    console.log(`Mã giao dịch đối soát: ${transaction.transactionMappingId || 'N/A'}`);
    console.log(`Mã tham chiếu: ${transaction.phase2Trace || 'N/A'}`);
    console.log(`Thông tin: ${transaction.transactionNoteSpos || transaction.payLoadMms?.descFromMVn || 'N/A'}`);
}

async function runVnpayBot() {
    // THÔNG TIN CHUẨN XÁC CỦA BẠN
    const USERNAME = process.env.VNPAY_USERNAME; 
    const PASSWORD = process.env.VNPAY_PASSWORD; 
    const DEFAULT_AMOUNT_TO_GENERATE = Number(process.env.DEFAULT_QR_AMOUNT || 10000);
    const API_BASE_URL = 'https://doitac.vnpay.vn/mcview-backoffice';
    const TRANSACTION_HISTORY_PATH = 'transaction/search';
    const TRANSACTION_DETAIL_PATH = 'transaction/detailV2';
    const TRANSACTION_PAGE_SIZE = 30;

    let sessionData = { deviceId: null, cookies: null };
    if (fs.existsSync(SESSION_FILE)) {
        try {
            sessionData = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            console.log("-> Đã nạp Cookie và DeviceID từ phiên trước.");
        } catch (e) {
            fs.unlinkSync(SESSION_FILE);
        }
    }
    
    if (!sessionData.deviceId) sessionData.deviceId = crypto.randomBytes(16).toString('hex');

    const jar = sessionData.cookies ? CookieJar.deserializeSync(sessionData.cookies) : new CookieJar();
    const client = wrapper(axios.create({ jar, withCredentials: true }));
    
    const { codeVerifier, codeChallenge } = generatePKCE();
    const clientId = 'vnpay-merchant-view';
    const redirectUri = 'https://doitac.vnpay.vn/login';

    console.log("\n==========================================");
    console.log("1. KHỞI TẠO ĐĂNG NHẬP KEYCLOAK SSO (OIDC)");
    console.log("==========================================");
    
    const authUrl = `https://sso.vnpay.vn/realms/vnpayid/protocol/openid-connect/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid+profile+email+login_method+phone_number+locale_callback&state=${crypto.randomBytes(16).toString('hex')}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
    
    let res = await client.get(authUrl);
    let html = res.data;
    let authCode = null;

    const currentUrl = res.request?.res?.responseUrl || res.request?.responseURL || res.config?.url || "";
    if (currentUrl.includes('code=')) {
        authCode = new URL(currentUrl).searchParams.get('code');
        console.log("✅ Bỏ qua UI đăng nhập, dùng lại Session Cookie cũ!");
    } 
    else {
        let stepLimit = process.env.MAX_STEP_LIMIT ? parseInt(process.env.MAX_STEP_LIMIT) : 10;
        let lastPageId = null;
        let samePageCount = 0;

        while (stepLimit-- > 0) {
            const { loginAction, pageId, errorMessage } = extractKcData(html);
            
            if (errorMessage) {
                console.log(`\n❌ Keycloak báo lỗi: ${errorMessage}`);
                if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
                rl.close(); return;
            }

            if (!loginAction) break;

            if (pageId === lastPageId && !pageId.includes('otp')) {
                samePageCount++;
                if (samePageCount > 1) {
                    console.log(`\n❌ Bị kẹt ở màn hình [${pageId}]. Vui lòng kiểm tra lại mật khẩu.`);
                    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
                    rl.close(); return;
                }
            } else {
                samePageCount = 0;
            }
            lastPageId = pageId;

            let payload = {};
            if (pageId === 'login-username.ftl' || pageId === 'login.ftl') {
                console.log("-> Đang gửi số điện thoại...");
                payload = { username: USERNAME, deviceId: sessionData.deviceId };
            } else if (pageId && (pageId.includes('select') || pageId.includes('discovery') || pageId.includes('method'))) {
                console.log("-> Chọn phương thức đăng nhập bằng mật khẩu...");
                payload = { method: 'password' };
            } else if (pageId && pageId.includes('password')) {
                console.log("-> Đang gửi mật khẩu...");
                payload = { username: USERNAME, password: PASSWORD };
            } else if (pageId && (pageId.includes('otp') || pageId.includes('sms'))) {
                const otp = await askQuestion("-> [CẦN HÀNH ĐỘNG] Nhập mã OTP: ");
                payload = { otp: otp };
            } else {
                break;
            }

            try {
                let nextRes = await client.post(loginAction, new URLSearchParams(payload).toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    maxRedirects: 0,
                    validateStatus: status => status >= 200 && status <= 302
                });

                if (nextRes.status === 302) {
                    const redirectLocation = nextRes.headers.location;
                    if (redirectLocation.includes('code=')) {
                        authCode = new URL(redirectLocation).searchParams.get('code');
                        break;
                    } else {
                        html = (await client.get(redirectLocation)).data;
                    }
                } else {
                    html = nextRes.data;
                    const checkErr = extractKcData(html);
                    if (checkErr.errorMessage) {
                        console.log(`\n❌ Lỗi đăng nhập: ${checkErr.errorMessage}`);
                        if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
                        rl.close(); return;
                    }
                }
            } catch (error) {
                console.error("Lỗi HTTP:", error.message);
                break;
            }
        }
    }

    if (!authCode) {
        console.log("❌ Lỗi: Không lấy được Authorization Code. Xóa session...");
        if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
        rl.close(); return;
    }

    const tokenRes = await client.post('https://sso.vnpay.vn/realms/vnpayid/protocol/openid-connect/token', new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code: authCode,
        code_verifier: codeVerifier
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    
    const idSafeAuthToken = tokenRes.data.access_token; 
    console.log("✅ Đã đổi Authorization Code lấy Token SSO thành công!");

    sessionData.cookies = jar.toJSON();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2), 'utf8');

    console.log("\n==========================================");
    console.log("2. KẾT NỐI HỆ THỐNG VNPAY MERCHANT");
    console.log("==========================================");

    const verifiedPhone = getPhoneFromToken(idSafeAuthToken) || USERNAME;

    console.log("-> Đang yêu cầu Token nội bộ VNPAY (MAM)...");
    const internalAuthRes = await client.post('https://doitac.vnpay.vn/mcview-backoffice/v2/authenticate', JSON.stringify({
        idSafeAuth: idSafeAuthToken,
        username: verifiedPhone
    }), { 
        headers: { 
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'authorization': 'null',
            'idsafeauth': `Bearer ${idSafeAuthToken}`,
            'merchantcifid': 'undefined',
            'merchantid': 'undefined',
            'type': 'MAM',
            'umsauth': 'null'
        } 
    });
    
    if (internalAuthRes.data.code !== "00") {
        console.log("❌ VNPAY từ chối cấp Token:", internalAuthRes.data);
        rl.close(); return;
    }

    // ==========================================
    // FIX TẠI ĐÂY: Nhận diện biến `jwtToken`
    // ==========================================
    let internalToken = null;
    const authData = internalAuthRes.data;
    if (typeof authData.data === 'string') {
        internalToken = authData.data;
    } else if (authData.data?.jwtToken) {         // <--- THÊM DÒNG NÀY ĐỂ BẮT jwtToken
        internalToken = authData.data.jwtToken;
    } else if (authData.data?.token) {
        internalToken = authData.data.token;
    } else if (authData.d10000ata?.accessToken) {
        internalToken = authData.data.accessToken;
    }

    if (!internalToken) {
        console.log("❌ Cấu trúc trả về không chứa Token.");
        rl.close(); return;
    }

    const apiHeaders = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'authorization': `Bearer ${internalToken}`,
        'idsafeauth': `Bearer ${idSafeAuthToken}`,
        'merchantcifid': 'undefined',
        'merchantid': 'undefined',
        'type': 'MAM',
        'umsauth': 'null'
    };

    async function configureMerchantContext(forceSelection = false) {
        console.log("-> Lấy danh sách merchant...");
        const merchantRes = await client.post(
            'https://doitac.vnpay.vn/mcview-backoffice/user/management-merchant',
            "{}",
            { headers: apiHeaders }
        );

        if (merchantRes.data.code !== "00" || !Array.isArray(merchantRes.data.data) || merchantRes.data.data.length === 0) {
            throw new Error(`Không lấy được thông tin merchant: ${merchantRes.data.message || 'response không hợp lệ'}`);
        }

        const merchantOptions = Array.from(
            new Map(
                merchantRes.data.data
                    .filter(item => item.merchantId)
                    .map(item => [String(item.merchantId), item])
            ).values()
        );
        if (merchantOptions.length === 0) {
            throw new Error('Danh sách không có merchant hợp lệ.');
        }

        const saved = sessionData.selectedContext;
        const savedMerchant = !forceSelection && saved
            ? merchantOptions.find(item => String(item.merchantId) === String(saved.merchantId))
            : null;
        const selectedMerchant = savedMerchant || await selectFromList(
            merchantOptions,
            'DANH SÁCH MERCHANT',
            merchant => `${merchant.merchant?.name || merchant.merchantName || 'Không rõ tên'} (merchantId: ${merchant.merchantId})`
        );
        const merchantId = selectedMerchant.merchantId;

        apiHeaders['merchantcifid'] = merchantId.toString();
        apiHeaders['merchantid'] = merchantId.toString();

        console.log(`-> Đang lấy danh sách shop và terminal cho merchantId=${merchantId}...`);
        const terminalRes = await client.post(
            'https://doitac.vnpay.vn/mcview-backoffice/system/terminal',
            { merchantId, shopId: "" },
            { headers: apiHeaders }
        );

        if (terminalRes.data.code !== "00" || !Array.isArray(terminalRes.data.data) || terminalRes.data.data.length === 0) {
            throw new Error(`Không tìm thấy terminal: ${terminalRes.data.message || 'response không hợp lệ'}`);
        }

        const merchantTerminals = terminalRes.data.data.filter(
            terminal => String(terminal.merchantId) === String(merchantId)
        );
        const shopOptions = Array.from(
            new Map(
                merchantTerminals
                    .filter(terminal => terminal.shopId !== null && terminal.shopId !== undefined)
                    .map(terminal => [String(terminal.shopId), terminal])
            ).values()
        );
        if (shopOptions.length === 0) {
            throw new Error('Không tìm thấy shop thuộc merchant đã chọn.');
        }

        const savedShop = !forceSelection && saved && String(saved.merchantId) === String(merchantId)
            ? shopOptions.find(item => String(item.shopId) === String(saved.shopId))
            : null;
        const selectedShop = savedShop || await selectFromList(
            shopOptions,
            'DANH SÁCH SHOP',
            shop => `${shop.shopName || shop.shopCode || 'Shop'} (shopId: ${shop.shopId})`
        );
        const shopId = selectedShop.shopId;
        const shopTerminals = merchantTerminals.filter(
            terminal => String(terminal.shopId) === String(shopId)
        );
        const savedTerminal = !forceSelection && saved &&
            String(saved.merchantId) === String(merchantId) &&
            String(saved.shopId) === String(shopId)
            ? shopTerminals.find(item => String(item.id) === String(saved.terminalId))
            : null;
        const selectedTerminal = savedTerminal || await selectFromList(
            shopTerminals,
            'DANH SÁCH TERMINAL',
            terminal => `${terminal.terminalName || 'Terminal'} - ${terminal.terminalCode || 'N/A'} (terminalId: ${terminal.id})`
        );
        const terminalId = selectedTerminal.id;
        const context = {
            merchantId,
            shopId,
            terminalId,
            merchantName: selectedMerchant.merchant?.name || selectedMerchant.merchantName,
            shopName: selectedShop.shopName || selectedShop.shopCode,
            terminalName: selectedTerminal.terminalName
        };
        sessionData.selectedContext = context;
        fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2), 'utf8');
        console.log(`${saved && !forceSelection ? '✅ Đã dùng lại' : '✅ Đã chọn'} merchantId=${merchantId}, shopId=${shopId}, terminalId=${terminalId}`);
        return context;
    }

    let selectedContext = await configureMerchantContext();
    let { merchantId, shopId, terminalId } = selectedContext;

    async function createQr() {
        const amountInput = await askQuestion(`Số tiền cần tạo QR (mặc định ${DEFAULT_AMOUNT_TO_GENERATE}): `);
        const amount = amountInput.trim() ? Number(amountInput) : DEFAULT_AMOUNT_TO_GENERATE;
        if (!Number.isInteger(amount) || amount <= 0) {
            console.log('❌ Số tiền phải là số nguyên dương.');
            return;
        }

        console.log(`\nĐang tạo mã QR ${formatVnd(amount)}...`);
        const qrRes = await client.post(`${API_BASE_URL}/payment-utility/add`, {
            shopId,
            terminalId,
            productCode: "2",
            amount
        }, { headers: apiHeaders });

        if (qrRes.data.code !== "00" || !qrRes.data.data?.qrCode) {
            throw new Error(qrRes.data.message || 'API không trả về mã QR.');
        }

        const qrString = qrRes.data.data.qrCode;
        console.log("\n✅ [Chuỗi QR Code Gốc]:\n" + qrString + "\n");
        qrcode.generate(qrString, { small: true }, qrcodeAscii => console.log(qrcodeAscii));
    }

    async function fetchTransactionHistory(fromInput, toInput, pageNumber) {
        const response = await client.post(
            `${API_BASE_URL}/${TRANSACTION_HISTORY_PATH}?page=${pageNumber - 1}&size=${TRANSACTION_PAGE_SIZE}`,
            {
                typeSearch: 1,
                searchCommon: '',
                paymentSources: [],
                status: [],
                terminalIds: [],
                dateTransaction: '',
                fromDate: toVnpayDateTime(fromInput),
                toDate: toVnpayDateTime(toInput, true),
                showSocketComponent: false,
                statusExportBill: -1,
                pagination: {
                    current: pageNumber,
                    pageSize: TRANSACTION_PAGE_SIZE
                }
            },
            { headers: { ...apiHeaders, Referer: 'https://doitac.vnpay.vn/transaction/list' } }
        );

        if (response.data.code !== "00") {
            throw new Error(response.data.message || 'Không lấy được lịch sử giao dịch.');
        }
        return getTransactions(response.data);
    }

    async function showTransactionHistoryDetail(transaction) {
        const transactionMappingId = String(transaction.transactionMappingId || '').trim();
        const transactionMappingDate = transaction.transactionMappingDate;
        if (!transactionMappingId || !transactionMappingDate) {
            throw new Error('Giao dịch không có đủ transactionMappingId và transactionMappingDate.');
        }

        const response = await client.post(
            `${API_BASE_URL}/${TRANSACTION_DETAIL_PATH}`,
            {
                paymentSource: String(transaction.paymentSource ?? 1),
                transactionMappingId: Number(transactionMappingId),
                transactionMappingDate
            },
            { headers: { ...apiHeaders, Referer: 'https://doitac.vnpay.vn/transaction/list' } }
        );

        if (response.data.code !== "00" || !response.data.data) {
            throw new Error(response.data.message || 'Không lấy được chi tiết giao dịch.');
        }
        printTransactionDetail(response.data.data);
    }

    async function showTransactionHistory() {
        const fromInput = (await askQuestion('Từ ngày (DD/MM/YYYY): ')).trim();
        const toInput = (await askQuestion('Đến ngày (DD/MM/YYYY): ')).trim();
        const fromDate = parseDateInput(fromInput, 'Từ ngày');
        const toDate = parseDateInput(toInput, 'Đến ngày');
        const rangeInDays = Math.round((toDate - fromDate) / 86400000) + 1;
        if (toDate < fromDate || rangeInDays > 31) {
            throw new Error('Khoảng thời gian phải hợp lệ và không vượt quá 31 ngày.');
        }

        let pageNumber = 1;
        let transactions = await fetchTransactionHistory(fromInput, toInput, pageNumber);

        while (true) {
            console.log('\n==========================================');
            console.log('LỊCH SỬ GIAO DỊCH');
            console.log('==========================================');
            printTransactions(transactions, pageNumber);
            console.log('\n[N] Trang sau  [P] Trang trước  [S] Xem chi tiết  [B] Về menu');

            const choice = (await askQuestion('Chọn thao tác: ')).trim().toLowerCase();
            if (choice === 'b') return;

            if (choice === 'n') {
                if (transactions.length < TRANSACTION_PAGE_SIZE) {
                    console.log('Đã ở trang cuối.');
                    continue;
                }
                pageNumber += 1;
                transactions = await fetchTransactionHistory(fromInput, toInput, pageNumber);
                if (transactions.length === 0) {
                    pageNumber -= 1;
                    transactions = await fetchTransactionHistory(fromInput, toInput, pageNumber);
                    console.log('Đã ở trang cuối.');
                }
                continue;
            }

            if (choice === 'p') {
                if (pageNumber === 1) {
                    console.log('Đã ở trang đầu.');
                    continue;
                }
                pageNumber -= 1;
                transactions = await fetchTransactionHistory(fromInput, toInput, pageNumber);
                continue;
            }

            if (choice === 's') {
                if (transactions.length === 0) continue;
                const index = Number(await askQuestion(`Chọn giao dịch (1-${transactions.length}): `));
                if (!Number.isInteger(index) || index < 1 || index > transactions.length) {
                    console.log('❌ Số thứ tự giao dịch không hợp lệ.');
                    continue;
                }
                await showTransactionHistoryDetail(transactions[index - 1]);
                await askQuestion('\nNhấn Enter để quay lại danh sách: ');
                continue;
            }

            console.log('❌ Thao tác không hợp lệ.');
        }
    }

    async function showTransactionDetail() {
        const transactionMappingId = (await askQuestion('Nhập transactionMappingId: ')).trim();
        const transactionMappingDate = (await askQuestion('Nhập ngày giao dịch (DD/MM/YYYY HH:mm:ss): ')).trim();
        if (!transactionMappingId || !/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(transactionMappingDate)) {
            console.log('❌ Cần nhập transactionMappingId và ngày đúng định dạng DD/MM/YYYY HH:mm:ss.');
            return;
        }

        await showTransactionHistoryDetail({
            paymentSource: '1',
            transactionMappingId: Number(transactionMappingId),
            transactionMappingDate
        });
        await askQuestion('\nNhấn Enter để quay lại menu: ');
    }

    async function reconfigureMerchantContext() {
        const context = await configureMerchantContext(true);
        selectedContext = context;
        merchantId = context.merchantId;
        shopId = context.shopId;
        terminalId = context.terminalId;
        await askQuestion('\nĐã lưu cấu hình mới. Nhấn Enter để quay lại menu: ');
    }

    const actions = {
        '1': createQr,
        '2': showTransactionHistory,
        '3': showTransactionDetail,
        '4': reconfigureMerchantContext
    };

    while (true) {
        console.log('\n==========================================');
        console.log('VNPAY MERCHANT MENU');
        console.log('==========================================');
        console.log(`Merchant: ${selectedContext.merchantName || 'N/A'} (${merchantId})`);
        console.log(`Shop: ${selectedContext.shopName || 'N/A'} (${shopId})`);
        console.log(`Terminal: ${selectedContext.terminalName || 'N/A'} (${terminalId})`);
        console.log('1. Tạo mã QR thanh toán');
        console.log('2. Lấy lịch sử giao dịch (tối đa 31 ngày)');
        console.log('3. Xem chi tiết giao dịch');
        console.log('4. Cấu hình lại merchant/shop/terminal');
        console.log('0. Thoát');

        const choice = (await askQuestion('Chọn chức năng: ')).trim();
        if (choice === '0') break;
        if (!actions[choice]) {
            console.log('❌ Lựa chọn không hợp lệ.');
            continue;
        }

        try {
            await actions[choice]();
        } catch (error) {
            console.error(`❌ ${error.response?.data?.message || error.message}`);
        }
    }

    rl.close();
}

runVnpayBot().catch(console.error);