// frontend/app.js

const API_URL = 'http://localhost:8000';  // Change to https in prod

const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

// Apply theme
if (tg.themeParams) {
    const theme = tg.themeParams;
    document.documentElement.style.setProperty('--bg-start', theme.bg_color || '#0a0015');
    document.documentElement.style.setProperty('--bg-end', theme.section_bg_color || '#1a0033');
    document.documentElement.style.setProperty('--neon', theme.button_color || '#00ffea');
    document.documentElement.style.setProperty('--pink', theme.button_text_color || '#ff00aa');
}

let userId = null;
let currentTab = 'collections';

async function apiFetch(endpoint, options = {}) {
    try {
        const res = await fetch(`${API_URL}${endpoint}`, {
            ...options,
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });
        if (res.status === 401) {
            // Try refresh
            const refreshRes = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', credentials: 'include' });
            if (refreshRes.ok) {
                return apiFetch(endpoint, options);  // Retry
            } else {
                tg.showAlert('Session expired. Please re-auth');
                throw new Error('Auth failed');
            }
        }
        if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown error');
            throw new Error(`API error ${res.status}: ${errText}`);
        }
        return await res.json();
    } catch (err) {
        tg.showAlert('Connection error: ' + err.message);
        throw err;
    }
}

async function init() {
    try {
        const res = await apiFetch('/auth/verify', {
            method: 'POST',
            headers: { 'X-Telegram-Init-Data': tg.initData }
        });
        userId = res.user_id;
        renderApp();
        changeTab('collections');
    } catch (err) {
        tg.showAlert('Auth failed\n' + err.message);
    }
}

function renderApp() {
    // Use Vue for reactivity
    const app = Vue.createApp({
        data() {
            return { currentTab: 'collections', userId };
        },
        methods: {
            changeTab(tab) {
                this.currentTab = tab;
                loadContent();
            }
        }
    });
    app.mount('#root');
    // Render HTML with v-bind etc, but for simplicity, keep similar
    document.getElementById('root').innerHTML = `
        <nav class="tabs">
            <button @click="changeTab('collections')">Collections</button>
            <button @click="changeTab('inventory')">Inventory</button>
            <button @click="changeTab('market')">Market</button>
            <button @click="changeTab('leaderboard')">Leaderboard</button>
            <button @click="claimDaily">Claim Daily</button>
        </nav>
        <div id="content"></div>
    `;
}

async function loadContent(offset = 0, limit = 20) {
    try {
        let data;
        if (currentTab === 'collections') {
            data = await apiFetch('/collections');
            renderCollections(data);
        } else if (currentTab === 'inventory') {
            data = await apiFetch(`/inventory?offset=${offset}&limit=${limit}`);
            renderInventory(data);
        } else if (currentTab === 'market') {
            data = await apiFetch(`/market?offset=${offset}&limit=${limit}`);
            renderMarket(data);
        } else if (currentTab === 'leaderboard') {
            data = await apiFetch(`/leaderboard?offset=${offset}&limit=${limit}`);
            renderLeaderboard(data);
        }
    } catch (err) {}
}

function renderCollections(collections) {
    const cont = document.getElementById('content');
    cont.innerHTML = '';
    for (const [key, items] of Object.entries(collections)) {
        const section = document.createElement('div');
        section.className = 'collection';
        section.innerHTML = `<h2>${key.toUpperCase()}</h2><div class="grid"></div>`;
        const grid = section.querySelector('.grid');
        items.forEach(item => {
            const card = document.createElement('div');
            card.className = `card ${item.rarity}`;
            card.innerHTML = `
                <img src="${item.img}" alt="${item.name}">
                <div class="rarity">${item.rarity}</div>
                <div class="price">${item.price} Stars</div>
            `;
            card.onclick = () => tg.showAlert(`Buy ${item.name} for ${item.price} Stars?`);  # Placeholder for buy logic
            grid.appendChild(card);
        });
        cont.appendChild(section);
    }
}

function renderInventory(items) {
    const cont = document.getElementById('content');
    cont.innerHTML = '<div class="grid"></div>';
    const grid = cont.querySelector('.grid');
    items.forEach(item => {
        const card = document.createElement('div');
        card.className = `card ${item.rarity}`;
        card.innerHTML = `
            <img src="${item.img}" alt="${item.name}">
            <div class="rarity">${item.rarity}</div>
            <div class="timer" id="timer-${item.id}"></div>
        `;
        grid.appendChild(card);
        // Real-time timer
        const updateTimer = () => {
            const leftMs = item.expiry - Date.now();
            let text = leftMs > 0 ? `${Math.floor(leftMs / 86400000)}d` : 'Expired';
            document.getElementById(`timer-${item.id}`).innerText = text;
            document.getElementById(`timer-${item.id}`).className = `timer ${leftMs < 86400000*2 ? 'warning' : ''}`;
        };
        updateTimer();
        setInterval(updateTimer, 60000);  // Update every min
    });
}

function renderMarket(items) {
    const cont = document.getElementById('content');
    cont.innerHTML = '<div class="grid"></div>';
    const grid = cont.querySelector('.grid');
    items.forEach(item => {
        const card = document.createElement('div');
        card.className = `card ${item.rarity}`;
        card.innerHTML = `
            <img src="${item.img}" alt="${item.name}">
            <div class="rarity">${item.rarity}</div>
            <div class="price">${item.price} Stars</div>
        `;
        card.onclick = () => buyMarketItem(item.market_id, item.price, item.name);
        grid.appendChild(card);
    });
}

async function buyMarketItem(marketId, price, name) {
    if (!name || price <= 0 || isNaN(price)) {
        tg.showAlert('Invalid item data');
        return;
    }
    if (!confirm(`Buy "${name}" for ${price} Stars?`)) return;
    try {
        const res = await apiFetch(`/market/create_invoice/${marketId}`, { method: 'POST' });
        tg.openLink(res.invoice_link);
        tg.showAlert('Payment interface opened');
    } catch (err) {
        tg.showAlert('Error creating invoice: ' + err.message);
    }
}

function renderLeaderboard(data) {
    const cont = document.getElementById('content');
    cont.innerHTML = '<ul class="leaderboard"></ul>';
    const list = cont.querySelector('.leaderboard');
    data.forEach((entry, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>#${i+1}</span> User ${entry.user_id}: ${entry.score} points`;
        list.appendChild(li);
    });
}

async function claimDaily() {
    try {
        const res = await apiFetch('/daily/claim', { method: 'POST' });
        tg.showAlert('Claimed: ' + res.item);
        loadContent();
    } catch (err) {
        tg.showAlert('Claim error: ' + err.message);
    }
}

// Auto load
setInterval(() => {
    if (currentTab === 'inventory' || currentTab === 'market') {
        loadContent();
    }
}, 45000);

init();