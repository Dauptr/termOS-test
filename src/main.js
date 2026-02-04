import { marked } from 'marked';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import html from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';

// Register languages
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('xml', html);
hljs.registerLanguage('css', css);
// Import Highlight.js styles (Atom One Dark)
import 'highlight.js/styles/atom-one-dark.css';

/* --- CONFIGURATION & STATE --- */
const DEFAULT_MODEL = "llama-3.3-70b-versatile"; 
let GROQ_API_KEY = localStorage.getItem('termos_groq_key') || "";
let SYSTEM_PROMPT = "You are TermOS Kernel AI. Respond concisely. Use valid HTML/CSS/JS if asked to code.";

let userProfile = {
    name: localStorage.getItem('termos_username') || 'User_' + Math.floor(Math.random() * 10000),
    avatar: localStorage.getItem('termos_avatar') || "👤"
};
let tempAvatarData = null;

let currentRoom = "public"; 
let mqttClient = null;
let isAdmin = false;

// --- WEBRTC STATE ---
let localStream = null;
const peers = {}; 
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
    ]
};

// --- DOM ELEMENTS ---
const UI = {
    boot: document.getElementById('boot-screen'),
    bootText: document.getElementById('boot-text'),
    chat: document.getElementById('chat-container'),
    input: document.getElementById('user-input'),
    sendBtn: document.getElementById('send-btn'),
    apiDot: document.getElementById('api-status-dot'),
    roomDisp: document.getElementById('room-display'),
    codeOverlay: document.getElementById('code-editor-overlay'),
    codeArea: document.getElementById('code-area'),
    adminPanel: document.getElementById('admin-panel'),
    copilotChat: document.getElementById('copilot-chat'),
    copilotInput: document.getElementById('copilot-input'),
    apiKeyInput: document.getElementById('api-key-input'),
    profileModal: document.getElementById('profile-modal'),
    profilePreview: document.getElementById('profile-avatar-preview'),
    profileNameInput: document.getElementById('edit-name'),
    videoGrid: document.getElementById('video-grid'),
    btnVideoEnable: document.getElementById('btn-enable-video'),
    btnVideoDisable: document.getElementById('btn-disable-video')
};

// --- SOUND FX ---
const AudioFX = {
    ctx: new (window.AudioContext || window.webkitAudioContext)(),
    playTone: function(freq, type, duration) {
        if(this.ctx.state === 'suspended') this.ctx.resume();
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    },
    send: () => AudioFX.playTone(600, 'sine', 0.1),
    receive: () => AudioFX.playTone(400, 'sine', 0.1),
    error: () => AudioFX.playTone(150, 'sawtooth', 0.3),
    system: () => AudioFX.playTone(800, 'triangle', 0.1)
};

/* --- INITIALIZATION --- */
window.addEventListener('load', () => {
    // Attach Event Listeners for all buttons
    document.getElementById('btn-media-toggle').addEventListener('click', toggleMedia);
    document.getElementById('btn-profile').addEventListener('click', toggleProfile);
    document.getElementById('btn-kernel').addEventListener('click', triggerKernelThought);
    document.getElementById('btn-ide').addEventListener('click', toggleCodeEditor);
    document.getElementById('btn-admin').addEventListener('click', toggleAdmin);
    document.getElementById('btn-kernel-input').addEventListener('click', openKernelInput);
    document.getElementById('btn-media-close').addEventListener('click', toggleMedia);
    document.getElementById('tab-video-btn').addEventListener('click', () => switchMediaTab('video'));
    document.getElementById('tab-radio-btn').addEventListener('click', () => switchMediaTab('radio'));
    document.getElementById('btn-enable-video').addEventListener('click', startWebRTC);
    document.getElementById('btn-disable-video').addEventListener('click', stopWebRTC);
    document.getElementById('btn-save-key').addEventListener('click', saveApiKey);
    document.getElementById('btn-reset').addEventListener('click', resetSystem);
    document.getElementById('btn-upload-avatar').addEventListener('click', () => document.getElementById('avatar-upload').click());
    document.getElementById('btn-save-profile').addEventListener('click', saveProfile);
    document.getElementById('btn-cancel-profile').addEventListener('click', toggleProfile);
    document.getElementById('btn-github').addEventListener('click', pushToGitHub);
    document.getElementById('btn-close-ide').addEventListener('click', toggleCodeEditor);
    document.getElementById('btn-copilot-gen').addEventListener('click', sendCopilot);
    
    // Radio buttons
    document.getElementById('radio-btn-1').addEventListener('click', (e) => playRadio(e.currentTarget, 'https://cdn.pixabay.com/download/audio/2022/05/27/audio_1808fbf07a.mp3'));
    document.getElementById('radio-btn-2').addEventListener('click', (e) => playRadio(e.currentTarget, 'https://streams.ilovemusic.de/iloveradio17.mp3'));

    // Inputs
    UI.sendBtn.addEventListener('click', handleInput);
    UI.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleInput();
        }
    });
    UI.copilotInput.addEventListener('keydown', (e) => {
        if(e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendCopilot();
        }
    });

    document.getElementById('avatar-upload').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(event) {
            tempAvatarData = event.target.result;
            UI.profilePreview.innerHTML = `<img src="${tempAvatarData}" class="w-full h-full object-cover">`;
        };
        reader.readAsDataURL(file);
    });

    if(UI.apiKeyInput) UI.apiKeyInput.value = GROQ_API_KEY;

    setTimeout(() => {
        UI.boot.style.opacity = '0';
        setTimeout(() => {
            UI.boot.remove();
            initCosmos(); 
            startSystem();
        }, 800);
    }, 1500);
});

function startSystem() {
    updateStatus(!!GROQ_API_KEY);
    
    if(!GROQ_API_KEY) {
        setTimeout(() => {
            addSystemMessage("⚠️ NEURAL LINK MISSING KEY", "warning");
            AudioFX.error();
            toggleAdmin();
        }, 1000);
    } else {
        connectMQTT();
    }
    
    loadHistory();
    UI.input.focus();
}

/* --- API HANDLING --- */
async function safeFetch(messages, jsonMode = false) {
    if (!GROQ_API_KEY) throw new Error("API Key Missing");
    
    try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${GROQ_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: DEFAULT_MODEL,
                messages: messages,
                temperature: 0.7,
                max_tokens: 2048,
                response_format: jsonMode ? { "type": "json_object" } : undefined
            })
        });

        const data = await response.json();

        if (!response.ok) {
            const errMsg = data.error?.message || `HTTP ${response.status}`;
            if(response.status === 401) throw new Error("Invalid API Key");
            if(response.status === 429) throw new Error("Rate Limit: Too Many Requests");
            throw new Error(errMsg);
        }

        return data.choices[0].message.content;

    } catch (error) {
        throw error; 
    }
}

/* --- CHAT LOGIC --- */
async function handleInput() {
    const text = UI.input.value.trim();
    if (!text) return;

    UI.input.value = '';
    AudioFX.send();
    
    if (text.startsWith('/')) {
        handleCommand(text);
        return;
    }

    addUserMessage(text, true, userProfile.name, userProfile.avatar);
    
    if (mqttClient && mqttClient.isConnected()) {
        try {
            const payload = JSON.stringify({
                type: 'chat',
                user: userProfile.name,
                avatar: userProfile.avatar,
                text: text,
                ts: Date.now()
            });
            const topic = currentRoom === "public" ? "termos/public" : `termos/rooms/${currentRoom}`;
            const msg = new Paho.MQTT.Message(payload);
            msg.destinationName = topic;
            msg.qos = 1;
            mqttClient.send(msg);
            saveToHistory({type:'chat', user:userProfile.name, text, isMe:true});
        } catch(e) { console.error("MQTT Send Error", e); }
    }
}

function handleCommand(cmdStr) {
    const parts = cmdStr.split(' ');
    const cmd = parts[0].toLowerCase();

    switch(cmd) {
        case '/ai':
            const aiPrompt = cmdStr.substring(4).trim();
            if(aiPrompt) processAICommand(aiPrompt);
            else addSystemMessage("Usage: /ai [question]", "warning");
            break;
        case '/join':
            const room = parts[1];
            if(room) joinRoom(room);
            else addSystemMessage("Usage: /join [roomname]", "warning");
            break;
        case '/leave':
            leaveRoom();
            break;
        case '/nick':
            const newName = cmdStr.substring(6).trim();
            if(newName) changeNick(newName);
            else addSystemMessage("Usage: /nick [name]", "warning");
            break;
        case '/clear':
            UI.chat.innerHTML = '';
            localStorage.removeItem('termos_chat_history');
            break;
        case '/kernel':
            triggerKernelThought();
            break;
        case '/video':
            toggleMedia();
            break;
        case '/sys':
            if(parts[1] === 'install') {
                const moduleName = parts[2];
                if(moduleName) SystemRebuilder.install(moduleName);
                else addSystemMessage("Usage: /sys install [module]", "warning");
            }
            break;
        default:
            addSystemMessage(`Unknown command: ${cmd}`, "warning");
            AudioFX.error();
    }
}

/* --- ROBUST WEBRTC LOGIC --- */
async function startWebRTC() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStream = stream;

        UI.btnVideoEnable.classList.add('hidden-ui');
        UI.btnVideoDisable.classList.remove('hidden-ui');
        UI.btnVideoDisable.classList.add('flex-ui');
        
        addLocalVideo(stream);
        addSystemMessage("📹 Uplink Established. Broadcasting...", "info");

        broadcastWebRTC({ type: 'video_ready' });

    } catch (err) {
        addSystemMessage("Camera Error: " + err.message, "error");
        AudioFX.error();
    }
}

function stopWebRTC() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    Object.values(peers).forEach(pc => pc.close());
    for (let key in peers) delete peers[key];

    UI.videoGrid.innerHTML = '';
    UI.btnVideoDisable.classList.add('hidden-ui');
    UI.btnVideoDisable.classList.remove('flex-ui');
    UI.btnVideoEnable.classList.remove('hidden-ui');

    addSystemMessage
