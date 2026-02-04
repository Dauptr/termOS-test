/* --- LIBRARY SETUP (CDN MODE) --- */
// We use window.marked and window.hljs because they are loaded via CDN in index.html
const marked = window.marked;
const hljs = window.hljs;

// Register languages for Highlight.js
hljs.registerLanguage('javascript', javascript); 
hljs.registerLanguage('xml', xml); 
hljs.registerLanguage('css', css); 

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

    // Start Boot Sequence
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

    addSystemMessage("📹 Uplink Terminated.", "warning");
    
    broadcastWebRTC({ type: 'video_stop' });
}

async function handleOffer(data) {
    const sender = data.user;
    if(sender === userProfile.name) return;

    if (peers[sender]) {
        const pc = peers[sender];
        if (pc.signalingState === 'have-local-offer') {
             await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
             const answer = await pc.createAnswer();
             await pc.setLocalDescription(answer);
             broadcastWebRTC({ type: 'answer', sdp: answer, target: sender });
             return;
        }
    }

    const pc = createPeerConnection(sender);
    if(pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        broadcastWebRTC({ type: 'answer', sdp: answer, target: sender });
    }
}

async function handleAnswer(data) {
    const sender = data.user;
    const pc = peers[sender];
    if(pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
}

async function handleCandidate(data) {
    const sender = data.user;
    const pc = peers[sender];
    if(pc) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
            console.log("Candidate Error (Ignored)", e);
        }
    }
}

function handleVideoReady(sender) {
    if(sender === userProfile.name) return;
    if (localStream && !peers[sender]) {
        console.log(`Saw ${sender} ready. Initiating offer...`);
        initiateCall(sender);
    }
}

async function initiateCall(remoteUser) {
    if(peers[remoteUser]) return; 

    const pc = createPeerConnection(remoteUser);
    if(!pc) return;

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        broadcastWebRTC({ type: 'offer', sdp: offer, target: remoteUser });
    } catch(e) {
        console.error("Offer creation failed", e);
    }
}

function createPeerConnection(remoteUser) {
    const pc = new RTCPeerConnection(rtcConfig);
    peers[remoteUser] = pc;

    pc.onicecandidate = (e) => {
        if(e.candidate) {
            broadcastWebRTC({ type: 'candidate', candidate: e.candidate, target: remoteUser });
        }
    };

    pc.ontrack = (e) => {
        const el = document.getElementById(`vid-remote-${remoteUser}`);
        if(el) return; 

        const div = document.createElement('div');
        div.id = `vid-remote-${remoteUser}`;
        div.className = "video-container remote";
        div.innerHTML = `<video autoplay playsinline muted></video><div class="remote-label">${remoteUser}</div>`;
        div.querySelector('video').srcObject = e.streams[0];
        UI.videoGrid.appendChild(div);
        AudioFX.system();
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${remoteUser}: ${pc.connectionState}`);
        if(pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            delete peers[remoteUser];
            const el = document.getElementById(`vid-remote-${remoteUser}`);
            if(el) el.remove();
        }
    }

    if(localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    return pc;
}

function addLocalVideo(stream) {
    const div = document.createElement('div');
    div.id = "vid-local";
    div.className = "video-container local";
    div.innerHTML = `<video autoplay muted playsinline></video><div class="remote-label">ME</div>`;
    div.querySelector('video').srcObject = stream;
    UI.videoGrid.appendChild(div);
}

function broadcastWebRTC(payload) {
    if(mqttClient && mqttClient.isConnected()) {
        const topic = currentRoom === "public" ? "termos/public" : `termos/rooms/${currentRoom}`;
        const fullPayload = {
            ...payload,
            user: userProfile.name,
            type: 'webrtc' 
        };
        
        const msg = new Paho.MQTT.Message(JSON.stringify(fullPayload));
        msg.destinationName = topic;
        mqttClient.send(msg);
    }
}

function handleWebRTCMessage(data) {
    const type = data.type; 
    if(type === 'video_ready') handleVideoReady(data.user);
    else if(type === 'video_stop') handleLeaveCall(data.user);
    else if(type === 'offer') handleOffer(data);
    else if(type === 'answer') handleAnswer(data);
    else if(type === 'candidate') handleCandidate(data);
}

function handleLeaveCall(remoteUser) {
    if(peers[remoteUser]) {
        peers[remoteUser].close();
        delete peers[remoteUser];
        const el = document.getElementById(`vid-remote-${remoteUser}`);
        if(el) el.remove();
    }
}

/* --- SYSTEM MODULES --- */
const SystemRebuilder = {
    install: function(name) {
        name = name.toLowerCase();
        switch(name) {
            case 'matrix':
                this.toggleMatrix();
                break;
            case 'neon':
                document.documentElement.style.setProperty('--accent-primary', '#d946ef');
                document.documentElement.style.setProperty('--msg-user-bg', '#be185d');
                addSystemMessage("Theme: Neon Pink", "info");
                break;
            case 'cyber':
                document.documentElement.style.setProperty('--accent-primary', '#facc15');
                document.documentElement.style.setProperty('--msg-user-bg', '#ca8a04');
                addSystemMessage("Theme: Cyber Yellow", "info");
                break;
            default:
                addSystemMessage("Module not found: " + name, "warning");
        }
    },
    toggleMatrix: function() {
        const mCanvas = document.getElementById('matrix-canvas');
        if(mCanvas.style.display === 'block') {
            mCanvas.style.display = 'none';
            addSystemMessage("Module Matrix: Disabled", "warning");
        } else {
            mCanvas.style.display = 'block';
            initMatrix(); 
            addSystemMessage("Module Matrix: Active", "info");
        }
    }
};

/* --- MARKDOWN PARSING --- */
function parseMarkdown(text) {
    return marked.parse(text);
}

function highlightCode() {
    document.querySelectorAll('pre code').forEach((el) => {
        hljs.highlightElement(el);
    });
}

/* --- UI COMPONENTS --- */
function addSystemMessage(text, type = 'info') {
    const div = document.createElement('div');
    div.className = "flex justify-center my-3 z-10 msg-anim";
    
    let bg = "bg-purple-900/30 border-purple-500/30";
    let icon = "ℹ️";
    
    if(type === 'error') { 
        bg = "bg-red-900/30 border-red-500/50 api-error-pulse"; 
        icon = "⚠️";
    }
    if(type === 'warning') { bg = "bg-yellow-900/30 border-yellow-500/30"; icon = "⚡"; }
    if(type === 'join') { bg = "bg-green-900/30 border-green-500/30"; icon = "➕"; }

    div.innerHTML = `<span class="px-3 py-1 rounded-full text-[10px] font-bold tracking-widest text-gray-300 border ${bg} flex items-center gap-2">${icon} ${text}</span>`;
    UI.chat.appendChild(div);
    scrollToBottom();
}

function addUserMessage(text, isMe, senderName, senderAvatar) {
    const div = document.createElement('div');
    div.className = `flex gap-3 my-1 msg-anim ${isMe ? 'flex-row-reverse' : 'flex-row'}`;
    
    let avatarHTML = `<div class="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-[10px] font-bold text-white shrink-0">?</div>`;
    
    if (senderAvatar) {
        if(senderAvatar.startsWith('data:') || senderAvatar.startsWith('http')) {
            avatarHTML = `<div class="w-8 h-8 rounded-full overflow-hidden border border-white/20 shrink-0"><img src="${senderAvatar}" class="w-full h-full object-cover"></div>`;
        } else {
            avatarHTML = `<div class="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-lg shrink-0 border border-white/10">${senderAvatar}</div>`;
        }
    } else {
        avatarHTML = `<div class="w-8 h-8 rounded-full bg-${isMe?'purple':'cyan'}-600 flex items-center justify-center text-[10px] font-bold text-white shrink-0">${senderName.substring(0,2).toUpperCase()}</div>`;
    }

    const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    if(isMe) {
        div.innerHTML = `
            ${avatarHTML}
            <div class="flex flex-col items-end max-w-[80%]">
                <div class="bg-gradient-to-r from-purple-600 to-indigo-600 text-white p-2.5 rounded-2xl rounded-tr-none text-sm shadow-md break-words">${escapeHtml(text)}</div>
                <div class="text-[9px] text-gray-500 mt-0.5 mr-1">${time}</div>
            </div>
        `;
    } else {
        div.innerHTML = `
            ${avatarHTML}
            <div class="flex flex-col items-start max-w-[80%]">
                <div class="flex items-center gap-2 mb-0.5">
                    <span class="text-[10px] text-cyan-400 font-bold">${escapeHtml(senderName)}</span>
                </div>
                <div class="bg-white/10 border border-white/5 text-gray-200 p-2.5 rounded-2xl rounded-tl-none text-sm shadow-md break-words">${escapeHtml(text)}</div>
                <div class="text-[9px] text-gray-500 mt-0.5 ml-1">${time}</div>
            </div>
        `;
    }
    
    UI.chat.appendChild(div);
    scrollToBottom();
}

function addAIMessage(text) {
    const div = document.createElement('div');
    div.className = "flex gap-3 my-2 msg-anim";
    const htmlContent = parseMarkdown(text);
    
    div.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center text-xs font-bold text-white shadow-lg ring-1 ring-white/20 shrink-0">AI</div>
        <div class="flex-1 bg-slate-800/50 backdrop-blur border border-cyan-500/20 p-3 rounded-2xl rounded-tl-none text-sm text-gray-200 shadow-md">
            <div class="markdown-body text-xs">${htmlContent}</div>
        </div>
    `;
    UI.chat.appendChild(div);
    scrollToBottom();
    highlightCode(); 
}

function addThinking(id, label = "AI") {
    const div = document.createElement('div');
    div.id = id;
    div.className = "flex gap-3 my-2 msg-anim";
    div.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center animate-pulse text-[10px] font-bold">${label}</div>
        <div class="flex items-center gap-1 h-8 bg-white/5 px-3 rounded-full">
            <div class="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce"></div>
            <div class="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce" style="animation-delay: 0.1s"></div>
            <div class="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
        </div>
    `;
    UI.chat.appendChild(div);
    scrollToBottom();
}

function removeThinking(id) {
    const el = document.getElementById(id);
    if(el) el.remove();
}

/* --- PERSISTENCE --- */
function saveToHistory(msgObj) {
    try {
        let history = JSON.parse(localStorage.getItem('termos_chat_history') || '[]');
        history.push(msgObj);
        if(history.length > 50) history.shift(); 
        localStorage.setItem('termos_chat_history', JSON.stringify(history));
    } catch(e) {
        localStorage.removeItem('termos_chat_history');
    }
}

function loadHistory() {
    try {
        const history = JSON.parse(localStorage.getItem('termos_chat_history') || '[]');
        history.forEach(msg => {
            if(msg.type === 'chat') addUserMessage(msg.text, msg.isMe, msg.user, null);
        });
        if(history.length > 0) addSystemMessage(`Restored ${history.length} messages from local cache.`, "info");
    } catch(e) {
        console.error("History load error", e);
    }
}

/* --- COPILOT / IDE --- */
function toggleCodeEditor() {
    const isHidden = UI.codeOverlay.classList.contains('hidden-ui');
    
    if (isHidden) {
        UI.codeArea.value = document.documentElement.outerHTML;
        UI.codeOverlay.classList.remove('hidden-ui');
        UI.codeOverlay.classList.add('flex-ui');
        UI.copilotInput.focus();
    } else {
        UI.codeOverlay.classList.add('hidden-ui');
        UI.codeOverlay.classList.remove('flex-ui');
        UI.input.focus();
    }
}

function openKernelInput() {
    if (UI.codeOverlay.classList.contains('hidden-ui')) toggleCodeEditor();
    setTimeout(() => UI.copilotInput.focus(), 100);
}

async function sendCopilot() {
    const prompt = UI.copilotInput.value.trim();
    if(!prompt) return;
    
    UI.copilotInput.value = '';
    const uDiv = document.createElement('div');
    uDiv.className = "flex justify-end";
    uDiv.innerHTML = `<div class="bg-purple-600 text-white p-2 rounded-lg text-xs max-w-[90%] break-words">${escapeHtml(prompt)}</div>`;
    UI.copilotChat.appendChild(uDiv);

    const tDiv = document.createElement('div');
    tDiv.className = "text-cyan-500 text-xs italic animate-pulse";
    tDiv.innerText = "Generating...";
    UI.copilotChat.appendChild(tDiv);
    UI.copilotChat.scrollTop = UI.copilotChat.scrollHeight;

    try {
        const codeContext = UI.codeArea.value.substring(UI.codeArea.value.length - 2000);
        const messages = [
            { role: "system", content: "You are an expert frontend engineer. Return ONLY code block, no explanation." },
            { role: "user", content: `Current Code Context:\n${codeContext}\n\nRequest: ${prompt}` }
        ];
        
        let reply = await safeFetch(messages);
        if(reply.includes('```')) {
            reply = reply.split('```')[1];
            reply = reply.replace(/^(javascript|html|css)\n/, '');
        }

        tDiv.remove();
        const aDiv = document.createElement('div');
        aDiv.className = "flex gap-2";
        aDiv.innerHTML = `
            <div class="w-6 h-6 rounded bg-cyan-600 flex items-center justify-center text-[10px] text-white shrink-0">AI</div>
            <div class="bg-black/40 border border-cyan-500/30 p-2 rounded text-[10px] font-mono text-cyan-100 max-h-40 overflow-y-auto w-full">${escapeHtml(reply)}</div>
        `;
        UI.copilotChat.appendChild(aDiv);
        
        const btnDiv = document.createElement('div');
        btnDiv.className = "text-center my-2";
        btnDiv.innerHTML = `<button onclick="applyCode(\`${escapeJs(reply)}\`)" class="bg-cyan-600 hover:bg-cyan-500 text-white text-[10px] px-3 py-1 rounded shadow-lg">APPLY PATCH</button>`;
        UI.copilotChat.appendChild(btnDiv);

    } catch (e) {
        tDiv.innerText = "Error: " + e.message;
        tDiv.classList.add('text-red-500');
    }
}

function applyCode(code) {
    const cursorPos = UI.codeArea.selectionStart;
    const text = UI.codeArea.value;
    const newText = text.slice(0, cursorPos) + "\n" + code + "\n" + text.slice(cursorPos);
    UI.codeArea.value = newText;
    addSystemMessage("Code applied to buffer.", "info");
}

function escapeJs(str) {
    return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

/* --- FIXED GITHUB EVOLUTION --- */
async function pushToGitHub() {
    const owner = prompt("GitHub Username:");
    if(!owner) return;
    const repo = prompt("Repository Name:");
    if(!repo) return;
    const token = prompt("Personal Access Token (needs repo scope):");
    if(!token) return;

    const path = "index.html";
    const content = UI.codeArea.value;
    const encodedContent = btoa(unescape(encodeURIComponent(content)));

    let defaultBranch = "main"; 
    try {
        const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            headers: { 'Authorization': `token ${token}` }
        });
        
        if (!repoRes.ok) {
            if(repoRes.status === 404) {
                alert("❌ Repository Not Found.\nPlease check the Username and Repository Name spelling.");
                return;
            }
            if(repoRes.status === 401 || repoRes.status === 403) {
                alert("❌ Authentication Failed.\nCheck your Token permissions (needs 'repo' scope).");
                return;
            }
            const err = await repoRes.json();
            throw new Error(err.message);
        }

        const repoData = await repoRes.json();
        defaultBranch = repoData.default_branch;
        console.log("Default Branch detected:", defaultBranch);

    } catch (e) {
        alert("❌ Connection Error: " + e.message);
        return;
    }

    let sha = null;
    try {
        const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${defaultBranch}`, {
            headers: { 'Authorization': `token ${token}` }
        });

        if (fileRes.ok) {
            const fileData = await fileRes.json();
            sha = fileData.sha;
        } else if (fileRes.status !== 404) {
            throw new Error(`File Check Failed: ${fileRes.status}`);
        }
    } catch (e) {
        alert("❌ Error checking file: " + e.message);
        return;
    }

    try {
        const body = {
            message: "Update from TermOS",
            content: encodedContent,
            branch: defaultBranch
        };
        if (sha) body.sha = sha; 

        const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if(putRes.ok) {
            alert("✅ Successfully pushed to GitHub!");
        } else {
            const err = await putRes.json();
            alert("❌ GitHub Error: " + err.message);
        }
    } catch (e) {
        alert("❌ Network Error: " + e.message);
    }
}

/* --- KERNEL THOUGHT --- */
async function triggerKernelThought() {
    if(!GROQ_API_KEY) { toggleAdmin(); return; }
    
    const id = 'kernel-' + Date.now();
    addThinking(id, "OS");
    AudioFX.system();
    
    try {
        const context = `Time: ${new Date().toLocaleTimeString()}, User: ${userProfile.name}, Room: ${currentRoom}`;
        const messages = [
            { role: "system", content: `You are TermOS Kernel. ${context}. Suggest a system update or interesting fact about galaxy.` },
            { role: "user", content: "Analyze system state." }
        ];
        
        const reply = await safeFetch(messages);
        removeThinking(id);
        
        const div = document.createElement('div');
        div.className = "flex gap-3 my-4 msg-anim border border-cyan-500/30 bg-cyan-900/10 p-3 rounded-xl relative overflow-hidden";
        div.innerHTML = `
            <div class="absolute inset-0 bg-cyan-400/5 animate-pulse"></div>
            <div class="relative z-10">
                <div class="text-[10px] text-cyan-400 font-bold tracking-widest mb-1">KERNEL_THOUGHT_PROCESS.EXE</div>
                <div class="text-sm text-gray-200 font-light leading-relaxed">${escapeHtml(reply)}</div>
            </div>
        `;
        UI.chat.appendChild(div);
        scrollToBottom();

    } catch (e) {
        removeThinking(id);
        addSystemMessage("Kernel Panic: " + e.message, "error");
    }
}

/* --- UTILS --- */
function escapeHtml(text) {
    if(!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scrollToBottom() {
    UI.chat.scrollTo({ top: UI.chat.scrollHeight, behavior: 'smooth' });
}

function updateStatus(active) {
    if(active) {
        UI.apiDot.className = "w-1.5 h-1.5 rounded-full bg-green-400 shadow-[0_0_8px_#4ade80]";
        UI.roomDisp.innerText = currentRoom === "public" ? "PUBLIC CHANNEL" : `ROOM: ${currentRoom.toUpperCase()}`;
        UI.roomDisp.classList.add("text-green-400");
    } else {
        UI.apiDot.className = "w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse";
        UI.roomDisp.innerText = "OFFLINE";
        UI.roomDisp.classList.remove("text-green-400");
    }
}

function toggleAdmin() {
    const p = UI.adminPanel;
    if(p.classList.contains('hidden-ui')) {
        p.classList.remove('hidden-ui');
        p.classList.add('flex-ui');
    } else {
        p.classList.add('hidden-ui');
        p.classList.remove('flex-ui');
    }
}

function saveApiKey() {
    const key = UI.apiKeyInput.value.trim();
    if(key) {
        GROQ_API_KEY = key;
        localStorage.setItem('termos_groq_key', key);
        updateStatus(true);
        addSystemMessage("API Key Updated.", "info");
        connectMQTT();
    }
}

function resetSystem() {
    localStorage.clear();
    location.reload();
}

/* --- PROFILE --- */
function toggleProfile() {
    const p = UI.profileModal;
    if(p.classList.contains('hidden-ui')) {
        UI.profileNameInput.value = userProfile.name;
        if(userProfile.avatar.startsWith('data:') || userProfile.avatar.startsWith('http')) {
            UI.profilePreview.innerHTML = `<img src="${userProfile.avatar}" class="w-full h-full object-cover">`;
        } else {
            UI.profilePreview.innerText = userProfile.avatar;
        }
        tempAvatarData = null;
        p.classList.remove('hidden-ui');
        p.classList.add('flex-ui');
    } else {
        p.classList.add('hidden-ui');
        p.classList.remove('flex-ui');
    }
}

function saveProfile() {
    const newName = UI.profileNameInput.value.trim();
    if(newName) userProfile.name = newName;
    if(tempAvatarData) userProfile.avatar = tempAvatarData;
    
    localStorage.setItem('termos_username', userProfile.name);
    localStorage.setItem('termos_avatar', userProfile.avatar);
    
    if(mqttClient && mqttClient.isConnected()) {
         const payload = JSON.stringify({
            type: 'profile_update',
            user: userProfile.name,
            avatar: userProfile.avatar,
            ts: Date.now()
        });
        const topic = currentRoom === "public" ? "termos/public" : `termos/rooms/${currentRoom}`;
        const msg = new Paho.MQTT.Message(payload);
        msg.destinationName = topic;
        mqttClient.send(msg);
    }

    addSystemMessage(`Identity Updated: ${userProfile.name}`, "info");
    toggleProfile();
}

/* --- MQTT --- */
function connectMQTT() {
    if (typeof Paho === 'undefined') return;
    
    const clientId = "termos_client_" + Math.random().toString(16).substr(2, 8);
    mqttClient = new Paho.MQTT.Client("broker.emqx.io", 8084, "/mqtt", clientId);

    mqttClient.onConnectionLost = (responseObject) => {
        if (responseObject.errorCode !== 0) updateStatus(false);
    };

    mqttClient.onMessageArrived = (message) => {
        try {
            const payload = JSON.parse(message.payloadString);
            const sender = payload.user;

            if (payload.type === 'chat') {
                if (sender !== userProfile.name) {
                    AudioFX.receive();
                    addUserMessage(payload.text, false, sender, payload.avatar);
                }
            }

            if (payload.type === 'join' && sender !== userProfile.name) {
                 addSystemMessage(`${sender} joined.`, "join");
                 AudioFX.system();
                 if(localStream) {
                     initiateCall(sender);
                 }
            }
            if (payload.type === 'leave' && sender !== userProfile.name) addSystemMessage(`${sender} disconnected.`, "warning");

            if (payload.type === 'profile_update' && sender !== userProfile.name) {
                addSystemMessage(`${sender} updated identity.`, "info");
            }

            if (payload.type === 'webrtc') {
                handleWebRTCMessage(payload);
            }

        } catch(e) { console.error(e); }
    };

    const options = {
        timeout: 3,
        useSSL: true,
        onSuccess: () => {
            mqttClient.subscribe("termos/public", { qos: 1 });
            updateStatus(true);
            const joinMsg = new Paho.MQTT.Message(JSON.stringify({ type: 'join', user: userProfile.name }));
            joinMsg.destinationName = "termos/public";
            mqttClient.send(joinMsg);
            addSystemMessage("Connected to Galactic Grid.", "info");
        },
        onFailure: (message) => {
            updateStatus(false);
            addSystemMessage("MQTT Connection Failed.", "error");
        }
    };
    mqttClient.connect(options);
}

function joinRoom(roomName) {
    if(roomName === currentRoom) return;
    
    stopWebRTC();

    if(mqttClient && mqttClient.isConnected()) {
         mqttClient.unsubscribe(currentRoom === "public" ? "termos/public" : `termos/rooms/${currentRoom}`);
    }
    currentRoom = roomName;
    updateStatus(true);
    addSystemMessage(`Switched to frequency: ${roomName}`, "info");
    if (mqttClient && mqttClient.isConnected()) {
        mqttClient.subscribe(`termos/rooms/${currentRoom}`, { qos: 1 });
        const joinMsg = new Paho.MQTT.Message(JSON.stringify({ type: 'join', user: userProfile.name }));
        joinMsg.destinationName = `termos/rooms/${currentRoom}`;
        mqttClient.send(joinMsg);
    }
}

function leaveRoom() {
    joinRoom("public");
}

/* --- MEDIA --- */
function toggleMedia() {
    const deck = document.getElementById('media-deck');
    deck.classList.toggle('active');
}

function switchMediaTab(tab) {
    document.getElementById('tab-video').classList.add('hidden');
    document.getElementById('tab-radio').classList.add('hidden');
    document.getElementById('tab-'+tab).classList.remove('hidden');
}

let audioObj = new Audio();
function playRadio(el, url) {
    if(audioObj.src === url && !audioObj.paused) {
        audioObj.pause();
        el.classList.remove('bg-white/20');
        return;
    }
    audioObj.src = url;
    audioObj.play().catch(e => addSystemMessage("Audio Error: "+e.message, "error"));
    document.querySelectorAll('.bg-white\\/20').forEach(d => d.classList.remove('bg-white/20'));
    el.classList.add('bg-white/20');
}

/* --- VISUALS (SIMPLER MAP) --- */
function initCosmos() {
    const canvas = document.getElementById('cosmic-canvas');
    const ctx = canvas.getContext('2d');
    let w = canvas.width = window.innerWidth;
    let h = canvas.height = window.innerHeight;
    
    const stars = Array(100).fill().map(() => ({
        x: Math.random() * w,
        y: Math.random() * h,
        size: Math.random() * 2 + 1, 
        opacity: Math.random() * 0.5 + 0.1, 
        speed: Math.random() * 0.05 + 0.02 
    }));

    function draw() {
        ctx.clearRect(0, 0, w, h);
        
        stars.forEach(s => {
            ctx.fillStyle = `rgba(255, 255, 255, ${s.opacity})`;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
            ctx.fill();
            
            s.y -= s.speed;
            
            if(s.y < 0) {
                s.y = h;
                s.x = Math.random() * w;
            }
        });
        
        requestAnimationFrame(draw);
    }
    draw();
    
    window.addEventListener('resize', () => {
        w = canvas.width = window.innerWidth;
        h = canvas.height = window.innerHeight;
    });
}

function initMatrix() {
    const canvas = document.getElementById('matrix-canvas');
    if(canvas.dataset.running === "true") return;
    canvas.dataset.running = "true";
    
    const ctx = canvas.getContext('2d');
    let w = canvas.width = window.innerWidth;
    let h = canvas.height = window.innerHeight;
    
    const cols = Math.floor(w / 20) + 1;
    const ypos = Array(cols).fill(0);
    
    function matrix() {
        ctx.fillStyle = '#0001';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#0f0';
        ctx.font = '15pt monospace';
        
        ypos.forEach((y, ind) => {
            const text = String.fromCharCode(Math.random() * 128);
            const x = ind * 20;
            ctx.fillText(text, x, y);
            if (y > 100 + Math.random() * 10000) ypos[ind] = 0;
            else ypos[ind] = y + 20;
        });
    }
    setInterval(matrix, 50);
}

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

    addSystemMessage("📹 Uplink Terminated.", "warning");
    
    broadcastWebRTC({ type: 'video_stop' });
}

async function handleOffer(data) {
    const sender = data.user;
    if(sender === userProfile.name) return;

    if (peers[sender]) {
        const pc = peers[sender];
        if (pc.signalingState === 'have-local-offer') {
             await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
             const answer = await pc.createAnswer();
             await pc.setLocalDescription(answer);
             broadcastWebRTC({ type: 'answer', sdp: answer, target: sender });
             return;
        }
    }

    const pc = createPeerConnection(sender);
    if(pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        broadcastWebRTC({ type: 'answer', sdp: answer, target: sender });
    }
}

async function handleAnswer(data) {
    const sender = data.user;
    const pc = peers[sender];
    if(pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
}

async function handleCandidate(data) {
    const sender = data.user;
    const pc = peers[sender];
    if(pc) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } catch (e) {
            console.log("Candidate Error (Ignored)", e);
        }
    }
}

function handleVideoReady(sender) {
    if(sender === userProfile.name) return;
    if (localStream && !peers[sender]) {
        console.log(`Saw ${sender} ready. Initiating offer...`);
        initiateCall(sender);
    }
}

async function initiateCall(remoteUser) {
    if(peers[remoteUser]) return; 

    const pc = createPeerConnection(remoteUser);
    if(!pc) return;

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        broadcastWebRTC({ type: 'offer', sdp: offer, target: remoteUser });
    } catch(e) {
        console.error("Offer creation failed", e);
    }
}

function createPeerConnection(remoteUser) {
    const pc = new RTCPeerConnection(rtcConfig);
    peers[remoteUser] = pc;

    pc.onicecandidate = (e) => {
        if(e.candidate) {
            broadcastWebRTC({ type: 'candidate', candidate: e.candidate, target: remoteUser });
        }
    };

    pc.ontrack = (e) => {
        const el = document.getElementById(`vid-remote-${remoteUser}`);
        if(el) return; 

        const div = document.createElement('div');
        div.id = `vid-remote-${remoteUser}`;
        div.className = "video-container remote";
        div.innerHTML = `<video autoplay playsinline muted></video><div class="remote-label">${remoteUser}</div>`;
        div.querySelector('video').srcObject = e.streams[0];
        UI.videoGrid.appendChild(div);
        AudioFX.system();
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${remoteUser}: ${pc.connectionState}`);
        if(pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            delete peers[remoteUser];
            const el = document.getElementById(`vid-remote-${remoteUser}`);
            if(el) el.remove();
        }
    }

    if(localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    return pc;
}

function addLocalVideo(stream) {
    const div = document.createElement('div');
    div.id = "vid-local";
    div.className = "video-container local";
    div.innerHTML = `<video autoplay muted playsinline></video><div class="remote-label">ME</div>`;
    div.querySelector('video').srcObject = stream;
    UI.videoGrid.appendChild(div);
}

function broadcastWebRTC(payload) {
    if(mqttClient && mqttClient.isConnected()) {
        const topic = currentRoom === "public" ? "termos/public" : `termos/rooms/${currentRoom}`;
        const fullPayload = {
            ...payload,
            user: userProfile.name,
            type: 'webrtc' 
        };
        
        const msg = new Paho.MQTT.Message(JSON.stringify(fullPayload));
        msg.destinationName = topic;
        mqttClient.send(msg);
    }
}

function handleWebRTCMessage(data) {
    const type = data.type; 
    if(type === 'video_ready') handleVideoReady(data.user);
    else if(type === 'video_stop') handleLeaveCall(data.user);
    else if(type === 'offer') handleOffer(data);
    else if(type === 'answer') handleAnswer(data);
    else if(type === 'candidate') handleCandidate(data);
}

function handleLeaveCall(remoteUser) {
    if(peers[remoteUser]) {
        peers[remoteUser].close();
        delete peers[remoteUser];
        const el = document.getElementById(`vid-remote-${remoteUser}`);
        if(el) el.remove();
    }
}

/* --- SYSTEM MODULES --- */
const SystemRebuilder = {
    install: function(name) {
        name = name.toLowerCase();
        switch(name) {
            case 'matrix':
                this.toggleMatrix();
                break;
            case 'neon':
                document.documentElement.style.setProperty('--accent-primary', '#d946ef');
                document.documentElement.style.setProperty('--msg-user-bg', '#be185d');
                addSystemMessage("Theme: Neon Pink", "info");
                break;
            case 'cyber':
                document.documentElement.style.setProperty('--accent-primary', '#facc15');
                document.documentElement.style.setProperty('--msg-user-bg', '#ca8a04');
                addSystemMessage("Theme: Cyber Yellow", "info");
                break;
            default:
                addSystemMessage("Module not found: " + name, "warning");
        }
    },
    toggleMatrix: function() {
        const mCanvas = document.getElementById('matrix-canvas');
        if(mCanvas.style.display === 'block') {
            mCanvas.style.display = 'none';
            addSystemMessage("Module Matrix: Disabled", "warning");
        } else {
            mCanvas.style.display = 'block';
            initMatrix(); 
            addSystemMessage("Module Matrix: Active", "info");
        }
    }
};

/* --- MARKDOWN PARSING --- */
function parseMarkdown(text) {
    return marked.parse(text);
}

function highlightCode() {
    document.querySelectorAll('pre code').forEach((el) => {
        hljs.highlightElement(el);
    });
}

/* --- UI COMPONENTS --- */
function addSystemMessage(text, type = 'info') {
    const div = document.createElement('div');
    div.className = "flex justify-center my-3 z-10 msg-anim";
    
    let bg = "bg-purple-900/30 border-purple-500/30";
    let icon = "ℹ️";
    
    if(type === 'error') { 
        bg = "bg-red-900/30 border-red-500/50 api-error-pulse"; 
        icon = "⚠️";
    }
    if(type === 'warning') { bg = "bg-yellow-900/30 border-yellow-500/30"; icon = "⚡"; }
    if(type === 'join') { bg = "bg-green-900/30 border-green-500/30"; icon = "➕"; }

    div.innerHTML = `<span class="px-3 py-1 rounded-full text-[10px] font-bold tracking-widest text-gray-300 border ${bg} flex items-center gap-2">${icon} ${text}</span>`;
    UI.chat.appendChild(div);
    scrollToBottom();
}

function addUserMessage(text, isMe, senderName, senderAvatar) {
    const div = document.createElement('div');
    div.className = `flex gap-3 my-1 msg-anim ${isMe ? 'flex-row-reverse' : 'flex-row'}`;
    
    let avatarHTML = `<div class="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-[10px] font-bold text-white shrink-0">?</div>`;
    
    if (senderAvatar) {
        if(senderAvatar.startsWith('data:') || senderAvatar.startsWith('http')) {
            avatarHTML = `<div class="w-8 h-8 rounded-full overflow-hidden border border-white/20 shrink-0"><img src="${senderAvatar}" class="w-full h-full object-cover"></div>`;
        } else {
            avatarHTML = `<div class="w-8 h-8 rounded-full bg-gray-800 flex items-center justify-center text-lg shrink-0 border border-white/10">${senderAvatar}</div>`;
        }
    } else {
        avatarHTML = `<div class="w-8 h-8 rounded-full bg-${isMe?'purple':'cyan'}-600 flex items-center justify-center text-[10px] font-bold text-white shrink-0">${senderName.substring(0,2).toUpperCase()}</div>`;
    }

    const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    if(isMe) {
        div.innerHTML = `
            ${avatarHTML}
            <div class="flex flex-col items-end max-w-[80%]">
                <div class="bg-gradient-to-r from-purple-600 to-indigo-600 text-white p-2.5 rounded-2xl rounded-tr-none text-sm shadow-md break-words">${escapeHtml(text)}</div>
                <div class="text-[9px] text-gray-500 mt-0.5 mr-1">${time}</div>
            </div>
        `;
    } else {
        div.innerHTML = `
            ${avatarHTML}
            <div class="flex flex-col items-start max-w-[80%]">
                <div class="flex items-center gap-2 mb-0.5">
                    <span class="text-[10px] text-cyan-400 font-bold">${escapeHtml(senderName)}</span>
                </div>
                <div class="bg-white/10 border border-white/5 text-gray-200 p-2.5 rounded-2xl rounded-tl-none text-sm shadow-md break-words">${escapeHtml(text)}</div>
                <div class="text-[9px] text-gray-500 mt-0.5 ml-1">${time}</div>
            </div>
        `;
    }
    
    UI.chat.appendChild(div);
    scrollToBottom();
}

function addAIMessage(text) {
    const div = document.createElement('div');
    div.className = "flex gap-3 my-2 msg-anim";
    const htmlContent = parseMarkdown(text);
    
    div.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-400 to-blue-500 flex items-center justify-center text-xs font-bold text-white shadow-lg ring-1 ring-white/20 shrink-0">AI</div>
        <div class="flex-1 bg-slate-800/50 backdrop-blur border border-cyan-500/20 p-3 rounded-2xl rounded-tl-none text-sm text-gray-200 shadow-md">
            <div class="markdown-body text-xs">${htmlContent}</div>
        </div>
    `;
    UI.chat.appendChild(div);
    scrollToBottom();
    highlightCode(); 
}

function addThinking(id, label = "AI") {
    const div = document.createElement('div');
    div.id = id;
    div.className = "flex gap-3 my-2 msg-anim";
    div.innerHTML = `
        <div class="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center animate-pulse text-[10px] font-bold">${label}</div>
        <div class="flex items-center gap-1 h-8 bg-white/5 px-3 rounded-full">
            <div class="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce"></div>
            <div class="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce" style="animation-delay: 0.1s"></div>
            <div class="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-bounce" style="animation-delay: 0.2s"></div>
        </div>
    `;
    UI.chat.appendChild(div);
    scrollToBottom();
}

function removeThinking(id) {
    const el = document.getElementById(id);
    if(el) el.remove();
}

/* --- PERSISTENCE --- */
function saveToHistory(msgObj) {
    try {
        let history = JSON.parse(localStorage.getItem('termos_chat_history') || '[]');
        history.push(msgObj);
        if(history.length > 50) history.shift(); 
        localStorage.setItem('termos_chat_history', JSON.stringify(history));
    } catch(e) {
        localStorage.removeItem('termos_chat_history');
    }
}

function loadHistory() {
    try {
        const history = JSON.parse(localStorage.getItem('termos_chat_history') || '[]');
        history.forEach(msg => {
            if(msg.type === 'chat') addUserMessage(msg.text, msg.isMe, msg.user, null);
        });
        if(history.length > 0) addSystemMessage(`Restored ${history.length} messages from local cache.`, "info");
    } catch(e) {
        console.error("History load error", e);
    }
}

/* --- COPILOT / IDE --- */
function toggleCodeEditor() {
    const isHidden = UI.codeOverlay.classList.contains('hidden-ui');
    
    if (isHidden) {
        UI.codeArea.value = document.documentElement.outerHTML;
        UI.codeOverlay.classList.remove('hidden-ui');
        UI.codeOverlay.classList.add('flex-ui');
        UI.copilotInput.focus();
    } else {
        UI.codeOverlay.classList.add('hidden-ui');
        UI.codeOverlay.classList.remove('flex-ui');
        UI.input.focus();
    }
}

function openKernelInput() {
    if (UI.codeOverlay.classList.contains('hidden-ui')) toggleCodeEditor();
    setTimeout(() => UI.copilotInput.focus(), 100);
}

async function sendCopilot() {
    const prompt = UI.copilotInput.value.trim();
    if(!prompt) return;
    
    UI.copilotInput.value = '';
    const uDiv = document.createElement('div');
    uDiv.className = "flex justify-end";
    uDiv.innerHTML = `<div class="bg-purple-600 text-white p-2 rounded-lg text-xs max-w-[90%] break-words">${escapeHtml(prompt)}</div>`;
    UI.copilotChat.appendChild(uDiv);

    const tDiv = document.createElement('div');
    tDiv.className = "text-cyan-500 text-xs italic animate-pulse";
    tDiv.innerText = "Generating...";
    UI.copilotChat.appendChild(tDiv);
    UI.copilotChat.scrollTop = UI.copilotChat.scrollHeight;

    try {
        const codeContext = UI.codeArea.value.substring(UI.codeArea.value.length - 2000);
        const messages = [
            { role: "system", content: "You are an expert frontend engineer. Return ONLY code block, no explanation." },
            { role: "user", content: `Current Code Context:\n${codeContext}\n\nRequest: ${prompt}` }
        ];
        
        let reply = await safeFetch(messages);
        if(reply.includes('```')) {
            reply = reply.split('```')[1];
            reply = reply.replace(/^(javascript|html|css)\n/, '');
        }

        tDiv.remove();
        const aDiv = document.createElement('div');
        aDiv.className = "flex gap-2";
        aDiv.innerHTML = `
            <div class="w-6 h-6 rounded bg-cyan-600 flex items-center justify-center text-[10px] text-white shrink-0">AI</div>
            <div class="bg-black/40 border border-cyan-500/30 p-2 rounded text-[10px] font-mono text-cyan-100 max-h-40 overflow-y-auto w-full">${escapeHtml(reply)}</div>
        `;
        UI.copilotChat.appendChild(aDiv);
        
        const btnDiv = document.createElement('div');
        btnDiv.className = "text-center my-2";
        btnDiv.innerHTML = `<button onclick="applyCode(\`${escapeJs(reply)}\`)" class="bg-cyan-600 hover:bg-cyan-500 text-white text-[10px] px-3 py-1 rounded shadow-lg">APPLY PATCH</button>`;
        UI.copilotChat.appendChild(btnDiv);

    } catch (e) {
        tDiv.innerText = "Error: " + e.message;
        tDiv.classList.add('text-red-500');
    }
}

function applyCode(code) {
    const cursorPos = UI.codeArea.selectionStart;
    const text = UI.codeArea.value;
    const newText = text.slice(0, cursorPos) + "\n" + code + "\n" + text.slice(cursorPos);
    UI.codeArea.value = newText;
    addSystemMessage("Code applied to buffer.", "info");
}

function escapeJs(str) {
    return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

/* --- FIXED GITHUB EVOLUTION --- */
async function pushToGitHub() {
    const owner = prompt("GitHub Username:");
    if(!owner) return;
    const repo = prompt("Repository Name:");
    if(!repo) return;
    const token = prompt("Personal Access Token (needs repo scope):");
    if(!token) return;

    const path = "index.html";
    const content = UI.codeArea.value;
    const encodedContent = btoa(unescape(encodeURIComponent(content)));

    let defaultBranch = "main"; 
    try {
        const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            headers: { 'Authorization': `token ${token}` }
        });
        
        if (!repoRes.ok) {
            if(repoRes.status === 404) {
                alert("❌ Repository Not Found.\nPlease check the Username and Repository Name spelling.");
                return;
            }
            if(repoRes.status === 401 || repoRes.status === 403) {
                alert("❌ Authentication Failed.\nCheck your Token permissions (needs 'repo' scope).");
                return;
            }
            const err = await repoRes.json();
            throw new Error(err.message);
        }

        const repoData = await repoRes.json();
        defaultBranch = repoData.default_branch;
        console.log("Default Branch detected:", defaultBranch);

    } catch (e) {
        alert("❌ Connection Error: " + e.message);
        return;
    }

    let sha = null;
    try {
        const fileRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${defaultBranch}`, {
            headers: { 'Authorization': `token ${token}` }
        });

        if (fileRes.ok) {
            const fileData = await fileRes.json();
            sha = fileData.sha;
        } else if (fileRes.status !== 404) {
            throw new Error(`File Check Failed: ${fileRes.status}`);
        }
    } catch (e) {
        alert("❌ Error checking file: " + e.message);
        return;
    }

    try {
        const body = {
            message: "Update from TermOS",
            content: encodedContent,
            branch: defaultBranch
        };
        if (sha) body.sha = sha; 

        const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if(putRes.ok) {
            alert("✅ Successfully pushed to GitHub!");
        } else {
            const err = await putRes.json();
            alert("❌ GitHub Error: " + err.message);
        }
    } catch (e) {
        alert("❌ Network Error: " + e.message);
    }
}

/* --- KERNEL THOUGHT --- */
async function triggerKernelThought() {
    if(!GROQ_API_KEY) { toggleAdmin(); return; }
    
    const id = 'kernel-' + Date.now();
    addThinking(id, "OS");
    AudioFX.system();
    
    try {
        const context = `Time: ${new Date().toLocaleTimeString()}, User: ${userProfile.name}, Room: ${currentRoom}`;
        const messages = [
            { role: "system", content: `You are TermOS Kernel. ${context}. Suggest a system update or interesting fact about galaxy.` },
            { role: "user", content: "Analyze system state." }
        ];
        
        const reply = await safeFetch(messages);
        removeThinking(id);
        
        const div = document.createElement('div');
        div.className = "flex gap-3 my-4 msg-anim border border-cyan-500/30 bg-cyan-900/10 p-3 rounded-xl relative overflow-hidden";
        div.innerHTML = `
            <div class="absolute inset-0 bg-cyan-400/5 animate-pulse"></div>
            <div class="relative z-10">
                <div class="text-[10px] text-cyan-400 font-bold tracking-widest mb-1">KERNEL_THOUGHT_PROCESS.EXE</div>
                <div class="text-sm text-gray-200 font-light leading-relaxed">${escapeHtml(reply)}</div>
            </div>
        `;
        UI.chat.appendChild(div);
        scrollToBottom();

    } catch (e) {
        removeThinking(id);
        addSystemMessage("Kernel Panic: " + e.message, "error");
    }
}

/* --- UTILS --- */
function escapeHtml(text) {
    if(!text) return "";
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function scrollToBottom() {
    UI.chat.scrollTo({ top: UI.chat.scrollHeight, behavior: 'smooth' });
}

function updateStatus(active) {
    if(active) {
        UI.apiDot.className = "w-1.5 h-1.5 rounded-full bg-green-400 shadow-[0_0_8px_#4ade80]";
        UI.roomDisp.innerText = currentRoom === "public" ? "PUBLIC CHANNEL" : `ROOM: ${currentRoom.toUpperCase()}`;
        UI.roomDisp.classList.add("text-green-400");
    } else {
        UI.apiDot.className = "w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse";
        UI.roomDisp.innerText = "OFFLINE";
        UI.roomDisp.classList.remove("text-green-400");
    }
}

function toggleAdmin() {
    const p = UI.adminPanel;
    if(p.classList.contains('hidden-ui')) {
        p.classList.remove('hidden-ui');
        p.classList.add('flex-ui');
    } else {
        p.classList.add('hidden-ui');
        p.classList.remove('flex-ui');
    }
}

function saveApiKey() {
    const key = UI.apiKeyInput.value.trim();
    if(key) {
        GROQ_API_KEY = key;
        localStorage.setItem('termos_groq_key', key);
        updateStatus(true);
        addSystemMessage("API Key Updated.", "info");
        connectMQTT();
    }
}

function resetSystem() {
    localStorage.clear();
    location.reload();
}

/* --- PROFILE --- */
function toggleProfile() {
    const p = UI.profileModal;
    if(p.classList.contains('hidden-ui')) {
        UI.profileNameInput.value = userProfile.name;
        if(userProfile.avatar.startsWith('data:') || userProfile.avatar.startsWith('http')) {
            UI.profilePreview.innerHTML = `<img src="${userProfile.avatar}" class="w-full h-full object-cover">`;
        } else {
            UI.profilePreview.innerText = userProfile.avatar;
        }
        tempAvatarData = null;
        p.classList.remove('hidden-ui');
        p.classList.add('flex-ui');
    } else {
        p.classList.add('hidden-ui');
        p.classList.remove('flex-ui');
    }
}

function saveProfile() {
    const newName = UI.profileNameInput.value.trim();
    if(newName) userProfile.name = newName;
    if(tempAvatarData) userProfile.avatar = tempAvatarData;
    
    localStorage.setItem('termos_username', userProfile.name);
    localStorage.setItem('termos_avatar', userProfile.avatar);
    
    if(mqttClient && mqttClient.isConnected()) {
         const payload = JSON.stringify({
            type: 'profile_update',
            user: userProfile.name,
            avatar: userProfile.avatar,
            ts: Date.now()
        });
        const topic = currentRoom === "public" ? "termos/public" : `termos/rooms/${currentRoom}`;
        const msg = new Paho.MQTT.Message(payload);
        msg.destinationName = topic;
        mqttClient.send(msg);
    }

    addSystemMessage(`Identity Updated: ${userProfile.name}`, "info");
    toggleProfile();
}

/* --- MQTT --- */
function connectMQTT() {
    if (typeof Paho === 'undefined') return;
    
    const clientId = "termos_client_" + Math.random().toString(16).substr(2, 8);
    mqttClient = new Paho.MQTT.Client("broker.emqx.io", 8084, "/mqtt", clientId);

    mqttClient.onConnectionLost = (responseObject) => {
        if (responseObject.errorCode !== 0) updateStatus(false);
    };

    mqttClient.onMessageArrived = (message) => {
        try {
            const payload = JSON.parse(message.payloadString);
            const sender = payload.user;

            if (payload.type === 'chat') {
                if (sender !== userProfile.name) {
                    AudioFX.receive();
                    addUserMessage(payload.text, false, sender, payload.avatar);
                }
            }

            if (payload.type === 'join' && sender !== userProfile.name) {
                 addSystemMessage(`${sender} joined.`, "join");
                 AudioFX.system();
                 if(localStream) {
                     initiateCall(sender);
                 }
            }
            if (payload.type === 'leave' && sender !== userProfile.name) addSystemMessage(`${sender} disconnected.`, "warning");

            if (payload.type === 'profile_update' && sender !== userProfile.name) {
                addSystemMessage(`${sender} updated identity.`, "info");
            }

            if (payload.type === 'webrtc') {
                handleWebRTCMessage(payload);
            }

        } catch(e) { console.error(e); }
    };

    const options = {
        timeout: 3,
        useSSL: true,
        onSuccess: () => {
            mqttClient.subscribe("termos/public", { qos: 1 });
            updateStatus(true);
            const joinMsg = new Paho.MQTT.Message(JSON.stringify({ type: 'join', user: userProfile.name }));
            joinMsg.destinationName = "termos/public";
            mqttClient.send(joinMsg);
            addSystemMessage("Connected to Galactic Grid.", "info");
        },
        onFailure: (message) => {
            updateStatus(false);
            addSystemMessage("MQTT Connection Failed.", "error");
        }
    };
    mqttClient.connect(options);
}

function joinRoom(roomName) {
    if(roomName === currentRoom) return;
    
    stopWebRTC();

    if(mqttClient && mqttClient.isConnected()) {
         mqttClient.unsubscribe(currentRoom === "public" ? "termos/public" : `termos/rooms/${currentRoom}`);
    }
    currentRoom = roomName;
    updateStatus(true);
    addSystemMessage(`Switched to frequency: ${roomName}`, "info");
    if (mqttClient && mqttClient.isConnected()) {
        mqttClient.subscribe(`termos/rooms/${currentRoom}`, { qos: 1 });
        const joinMsg = new Paho.MQTT.Message(JSON.stringify({ type: 'join', user: userProfile.name }));
        joinMsg.destinationName = `termos/rooms/${currentRoom}`;
        mqttClient.send(joinMsg);
    }
}

function leaveRoom() {
    joinRoom("public");
}

/* --- MEDIA --- */
function toggleMedia() {
    const deck = document.getElementById('media-deck');
    deck.classList.toggle('active');
}

function switchMediaTab(tab) {
    document.getElementById('tab-video').classList.add('hidden');
    document.getElementById('tab-radio').classList.add('hidden');
    document.getElementById('tab-'+tab).classList.remove('hidden');
}

let audioObj = new Audio();
function playRadio(el, url) {
    if(audioObj.src === url && !audioObj.paused) {
        audioObj.pause();
        el.classList.remove('bg-white/20');
        return;
    }
    audioObj.src = url;
    audioObj.play().catch(e => addSystemMessage("Audio Error: "+e.message, "error"));
    document.querySelectorAll('.bg-white\\/20').forEach(d => d.classList.remove('bg-white/20'));
    el.classList.add('bg-white/20');
}

/* --- VISUALS (SIMPLER MAP) --- */
function initCosmos() {
    const canvas = document.getElementById('cosmic-canvas');
    const ctx = canvas.getContext('2d');
    let w = canvas.width = window.innerWidth;
    let h = canvas.height = window.innerHeight;
    
    const stars = Array(100).fill().map(() => ({
        x: Math.random() * w,
        y: Math.random() * h,
        size: Math.random() * 2 + 1, 
        opacity: Math.random() * 0.5 + 0.1, 
        speed: Math.random() * 0.05 + 0.02 
    }));

    function draw() {
        ctx.clearRect(0, 0, w, h);
        
        stars.forEach(s => {
            ctx.fillStyle = `rgba(255, 255, 255, ${s.opacity})`;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
            ctx.fill();
            
            s.y -= s.speed;
            
            if(s.y < 0) {
                s.y = h;
                s.x = Math.random() * w;
            }
        });
        
        requestAnimationFrame(draw);
    }
    draw();
    
    window.addEventListener('resize', () => {
        w = canvas.width = window.innerWidth;
        h = canvas.height = window.innerHeight;
    });
}

function initMatrix() {
    const canvas = document.getElementById('matrix-canvas');
    if(canvas.dataset.running === "true") return;
    canvas.dataset.running = "true";
    
    const ctx = canvas.getContext('2d');
    let w = canvas.width = window.innerWidth;
    let h = canvas.height = window.innerHeight;
    
    const cols = Math.floor(w / 20) + 1;
    const ypos = Array(cols).fill(0);
    
    function matrix() {
        ctx.fillStyle = '#0001';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#0f0';
        ctx.font = '15pt monospace';
        
        ypos.forEach((y, ind) => {
            const text = String.fromCharCode(Math.random() * 128);
            const x = ind * 20;
            ctx.fillText(text, x, y);
            if (y > 100 + Math.random() * 10000) ypos[ind] = 0;
            else ypos[ind] = y + 20;
        });
    }
    setInterval(matrix, 50);
}
