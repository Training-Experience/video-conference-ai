
let connections = [];
let calls = [];
let screenShareCalls = [];
let peer = null;
/** @type {MediaStream} */
let localStream = null;
/** @type {MediaStream} */
let screenStream = null;
let videoDeviceId = null;
let audioDeviceId = null;
let unreadMessageCounter = 0;
let originalPageTitle = document.title;
let questionLoadTries = 0;
let myVoiceActivityDetector = null;
let fakeAudioFile = null;
let volumeMeterProcessor = null;
let isTranscribing = false;
let backgroundBlurEnabled = false;
let emotionTimeline = [];
let emotionDetectionQueueCount = 0;
const IS_MOBILE = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
let emotionDetectionEnabled = false;

let urlParams = new URLSearchParams(window.location.search);

const selfieSegmentation = new SelfieSegmentation({
    locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
});

selfieSegmentation.setOptions({
    modelSelection: 1,
    selfieMode: true,
});

// enable emotion detection if not on mobile
document.querySelectorAll('.js-emotion-detection-btn').forEach((btn) => btn.classList.toggle('active', emotionDetectionEnabled));

if (IS_MOBILE) {
    document.querySelectorAll('.js-background-blur-btn').forEach((el) => el.style.display = 'none');
}


// Human.js config, set up filters, and which AI models to use for face, mesh, and emotion detection
const humanConfig = {
    modelBasePath: '/bundles/index/js/human/models',
    filter: {
        enabled: false
    },
    gesture: {
        enabled: false,
    },
    face: {
        enabled: true,
        detector: {
            modelPath: 'blazeface.json',
            rotation: false,
            maxDetected: 1,
            skipFrames: 99,
            skipTime: 2500,
            minConfidence: 0.2,
            minSize: 0,
            iouThreshold: 0.1,
            scale: 1.4,
            mask: false,
            return: false,
        },
        mesh: {
            enabled: true,
            modelPath: 'facemesh.json',
            keepInvalid: false,
        },
        attention: {
            enabled: true,
            modelPath: 'facemesh-attention.json',
        },
        iris: {
            enabled: false,
        },
        emotion: {
            enabled: true,
            minConfidence: 0.1,
            skipFrames: 99,
            skipTime: 1500,
            modelPath: 'affectnet-mobilenet.json',
        },
        description: {
            enabled: true,
            modelPath: 'faceres.json',
            skipFrames: 99,
            skipTime: 3000,
            minConfidence: 0.1,
        },
        antispoof: {
            enabled: false,
            skipFrames: 99,
            skipTime: 4000,
            modelPath: 'antispoof.json',
        },
        liveness: {
            enabled: false,
            skipFrames: 99,
            skipTime: 4000,
            modelPath: 'liveness.json',
        },
    },
    body: {
        enabled: false,
    },
    hand: {
        enabled: false,
    },
    object: {
        enabled: false,
    },
    segmentation: {
        enabled: false,
    },
};

let human = new Human.Human(humanConfig);

let conferenceContainer = document.getElementById('conference_container');
let preJoinContainer = document.getElementById('pre_join_container');

let localVideo = document.getElementById('self_video');
let videoPreview = document.getElementById('video_preview');

// Set up pre join conference preview
const videoInputSelect = document.getElementById('cameraSelect');
const audioInputSelect = document.getElementById('microphoneSelect');

if (IS_MOBILE) {
    document.querySelector('.device-settings').style.display = 'none';
}

$(document).ready(function () {
    getLocalStream().then(() => updateDeviceList());

    function updateDeviceList() {
        navigator.mediaDevices.enumerateDevices().then(devices => {
            videoInputSelect.innerHTML = '';
            audioInputSelect.innerHTML = '';
            devices.forEach(device => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label;
                if (device.kind === 'videoinput') {
                    videoInputSelect.appendChild(option);
                } else if (device.kind === 'audioinput') {
                    audioInputSelect.appendChild(option);
                }
            });
        });
    }

    navigator.mediaDevices.addEventListener('devicechange', () => {
        updateDeviceList();
    });

    videoInputSelect.addEventListener('change', function () {
        videoDeviceId = this.value;
        getLocalStream(true);
    });
    audioInputSelect.addEventListener('change', function () {
        audioDeviceId = this.value;
        getLocalStream(true);
        console.log('audio changed');
    });
});

/**
 * Initalize Peer.js connection and event listeners
 */
function initializeRoomCall() {
    let joinButton = document.getElementById('join_button');
    joinButton.querySelector('.fa-spinner').classList.toggle('hidden', false);
    getLocalStream();

    let webRtcConfig = {
        'iceServers': [
            { urls: 'stun:stun.l.google.com:19302'},
            { urls: 'stun:freeturn.net:5349' },
            { urls: 'turns:freeturn.tel:5349', username: 'free', credential: 'free' }
        ]
    };

    if (turn_credentials) {
        webRtcConfig.iceServers.push({
            urls: [
                "stun:stun.cloudflare.com:3478",
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:3478?transport=tcp",
                "turns:turn.cloudflare.com:5349?transport=tcp"
            ],
            username: turn_credentials.username,
            credential: turn_credentials.credential
        });
    }

    peer = new Peer(uniqueToken, {
        config: webRtcConfig
    });

    peer.on('connection', (conn) => {
        console.log('incoming peer connection', conn);
        handleConnections(conn);
    });

    peer.on('call', (call) => {
        console.log('incoming call', call);
        if (call.metadata && call.metadata.type === 'screenShare') {
            call.answer();
            handleStreams(call, true);
        } else {
            // Ignore duplicate calls from the same peer
            if (calls.some(c => (c.peer === call.peer && c.open))) {
                console.log('ignoring duplicate call', call);
                return;
            }
            calls.push(call);
            getLocalStream().then((localStream) => {
                call.answer(localStream);
                if (screenStream) {
                    console.log('adding screen share to call', call);
                    screenShareCalls.push(peer.call(call.peer, screenStream, {
                        metadata: { type: 'screenShare' }
                    }));
                }
                handleStreams(call);
            });
        }

        fetch(Routing.generate('video_conference_get_room_connections', { 'room': ROOM_ID }))
            .then(async (data) => {
                let response = await data.json();
                if (response.success && response.connections) {
                    connectedPeers = response.connections;
                }
            });
    });

    peer.on('disconnected', () => {
        console.log('peer disconnected');

    });

    peer.on('open', (id) => {
        console.log('peer open', id);

        fetch(Routing.generate('video_conference_connect_room', { 'room': ROOM_ID }))
            .then(async (data) => {
                let response = await data.json();
                if (response.success && response.connections) {
                    joinButton.querySelector('.fa-spinner').classList.toggle('hidden', true);
                    preJoinContainer.classList.toggle('hidden', true);
                    conferenceContainer.classList.toggle('hidden', false);

                    stopDisplayingVolumeLevel();

                    connectedPeers = response.connections;

                    for (let [token, connection] of Object.entries(connectedPeers)) {
                        if (token !== uniqueToken && connection.state === 'connected') {
                            callPeer(token);
                        }
                    }
                }
            })
            .catch(async (error) => {
                joinButton.querySelector('.fa-spinner').classList.toggle('hidden', true);
            });
    });

    peer.on('error', (err) => {
        throw new Error('peer error: ' + err + ' type: ' + err.type);
    });

    refreshInterviewerQuestions();
}

// Call room participant
function callPeer(token) {
    console.log('calling peer: ', token);
    try {
        getLocalStream().then((localStream) => {
            let call = localStream ? peer.call(token, localStream) : peer.call(token);
            call.on('error', (err) => {
                console.error('call error', err);
            });
            if (screenStream) {
                console.log('adding screen share to call', call);
                screenStream.getTracks().forEach(track => call.peerConnection.addTrack(track, screenStream));
            }
            handleStreams(call);
            calls.push(call);
            let conn =peer.connect(token, {
                reliable: true
            });
            conn.on('open', () => {
                handleConnections(conn);
            });
        });
    } catch (e) {
        console.error('call error', e);
    }

}

// Handle incoming stream, set up Emotion detection if it is not screen share stream
function handleStreams(call, isScreenShare = false) {
    let streamContainers = [];
    call.peerConnection.ontrack = (event) => {
        let stream = event.streams[0];
        if (document.querySelector('#video_container .stream-container[data-stream-id="' + stream.id + '"]')) {
            console.log('duplicate');
            return;
        }
        let streamContainer = document.createElement('div');
        streamContainer.classList.add('stream-container');
        if (isScreenShare) {
            streamContainer.classList.add('screen-share-stream');
            // Display message about scroll to zoom
            let scrollMessage = document.createElement('div');
            scrollMessage.classList.add('scroll-message');
            scrollMessage.classList.add('animated');
            scrollMessage.classList.add('fadeOut');
            scrollMessage.classList.add('delay-5s');
            scrollMessage.textContent = Translator.trans('interviews.video_conference.scroll_to_zoom', {}, 'interviews');
            streamContainer.appendChild(scrollMessage);
        }
        streamContainer.dataset.streamId = stream.id;
        streamContainer.dataset.peerId = call.peer;
        let remoteVideoEl = document.createElement('video');
        remoteVideoEl.srcObject = stream;
        remoteVideoEl.autoplay = true;
        streamContainer.appendChild(remoteVideoEl);

        if (!isScreenShare) {
            let userNameDiv = document.createElement('div');
            userNameDiv.classList.add('user-name');
            streamContainer.appendChild(userNameDiv);

            let emotionDiv = document.createElement('div');
            emotionDiv.classList.add('emotion');
            streamContainer.appendChild(emotionDiv);

            // Display user name
            fetch(Routing.generate('video_conference_get_room_connection_user_name', { 'room': ROOM_ID, 'connection': call.peer }))
                .then(response => response.json())
                .then(function (response) {
                    console.log(response);
                    if (response.userName) {
                        userNameDiv.textContent = response.userName;
                    }
                });
        }

        document.getElementById('video_container').appendChild(streamContainer);

        if (isScreenShare) {
            // Zoom and pan
            let MIN_SCALE = 1;
            let MAX_SCALE = 5;
            let scale = MIN_SCALE;
    
            let offsetX = 0;
            let offsetY = 0;
    
            let $video     = $(remoteVideoEl);
            let $container = $(streamContainer);
    
            let areaWidth  = $container.width();
            let areaHeight = $container.height();
    
            $container.on('wheel', function(event) {
                event.preventDefault();
                let clientX = event.originalEvent.pageX - $container.offset().left;
                let clientY = event.originalEvent.pageY - $container.offset().top;
    
                let nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale - event.originalEvent.deltaY / 100));

                if (nextScale === MIN_SCALE) {
                    offsetX = offsetY = 0;
                }
    
                let percentXInCurrentBox = clientX / areaWidth;
                let percentYInCurrentBox = clientY / areaHeight;
    
                let currentBoxWidth  = areaWidth / scale;
                let currentBoxHeight = areaHeight / scale;
    
                let nextBoxWidth  = areaWidth / nextScale;
                let nextBoxHeight = areaHeight / nextScale;
    
                let deltaX = (nextBoxWidth - currentBoxWidth) * (percentXInCurrentBox - 0.5);
                let deltaY = (nextBoxHeight - currentBoxHeight) * (percentYInCurrentBox - 0.5);
    
                let nextOffsetX = offsetX - deltaX;
                let nextOffsetY = offsetY - deltaY;
    
                $video.css({
                    transform : 'scale(' + nextScale + ')',
                    left      : -1 * nextOffsetX * nextScale,
                    right     : nextOffsetX * nextScale,
                    top       : -1 * nextOffsetY * nextScale,
                    bottom    : nextOffsetY * nextScale
                });

                offsetX = nextOffsetX;
                offsetY = nextOffsetY;
                scale   = nextScale;
            });

            //Ability to move zoomed in screenshare
            let isDragging = false;
            let startX, startY;

            remoteVideoEl.addEventListener('mousedown', function(e) {
                isDragging = true;
                startX = e.clientX - remoteVideoEl.offsetLeft;
                startY = e.clientY - remoteVideoEl.offsetTop;
            });

            streamContainer.addEventListener('mousemove', function(e) {
                if (isDragging) {
                    let deltaX = startX - e.clientX;
                    let deltaY = startY - e.clientY;

                    remoteVideoEl.style.top = -1 * deltaY + 'px';
                    remoteVideoEl.style.left = -1 * deltaX + 'px';
                }
            });

            document.addEventListener('mouseup', function(e) {
                if (isDragging) {
                    // offsetX = offsetX - (startX - e.clientX);
                    // offsetY = offsetY - (startY - e.clientY);
                    isDragging = false;
                }
            });
        }

        updateLocalViewSize();
        streamContainers.push(streamContainer);
    };
    call.on('close', () => {
        console.log('incoming call closed');
        for (let i = 0; i < streamContainers.length; i++) {
            try {
                streamContainers[i].remove();
            } catch (e) {
                // Nothing, because some stream containers are undefined
            }
        }
        if (!isScreenShare) {
            calls.splice(calls.indexOf(call), 1);
        }
        updateLocalViewSize();
    });
}

/**
 * Adds a connection to the list of connections and sets up event handlers for data and close events.
 */
function handleConnections(conn) {
    connections.push(conn);
    conn.on('data', (data) => {
        switch (data.type) {
            case 'message':
                createChatText(data.message, false, data.sender);
                break;
            case 'file':
                let blob = new Blob([data.blob], {type: data.fileType});
                let text = '<a download="' + data.name + '" href="' + URL.createObjectURL(blob) + '"><i class="fa fa-paperclip"></i> ' + data.name + '</a>';
                createFileDownloadLink(blob, data.name, false, data.sender);
                break;
            case 'emotion':
                if (emotionDetectionEnabled) {
                    let emotionDiv = document.querySelector('[data-peer-id="' + conn.peer + '"].stream-container .emotion');
                    emotionDiv.textContent = null;
                    if (!(data && data.data && data.data.emotions)) {
                        break;
                    }
                    for (const emotion of data.data.emotions) {
                        let emotionSpan = document.createElement('div');
                        emotionSpan.classList.add('text-strong');
                        emotionSpan.textContent = Translator.trans('interviews.video_conference.emotion.' + emotion.emotion, {}, 'interviews') + ': ' + (emotion.score * 100).toFixed(0) + '%';
                        emotionDiv.appendChild(emotionSpan);
                    }
                    // let interpolated = data.data;
                    // console.log('emotion received', conn.peer, data);
                    // emotionDiv.textContent = null;
                    // let faces = [];
                    // if (interpolated.persons && interpolated.persons.length > 0) {
                    //     for (const person of interpolated.persons) {
                    //         faces.push(person.face);
                    //     }
                    // } else if (interpolated.face && interpolated.face.length > 0) {
                    //     faces = interpolated.face;
                    // }
                    //
                    // for (let i = 0; i < faces.length; i++) {
                    //     if (faces[i].emotion.length === 0) {
                    //         continue;
                    //     }
                    //     if (i > 1) {
                    //         let breakDiv = document.createElement('br');
                    //         emotionDiv.appendChild(breakDiv);
                    //     }
                    //     if (faces.length > 1) {
                    //         let faceNumber = document.createElement('div');
                    //         faceNumber.classList.add('text-strong');
                    //         faceNumber.textContent = Translator.trans('interviews.video_conference.face', {}, 'interviews') + ' ' + (i + 1);
                    //         emotionDiv.appendChild(faceNumber);
                    //     }
                    //     for (const emotion of faces[i].emotion) {
                    //         let emotionSpan = document.createElement('div');
                    //         emotionSpan.classList.add('text-strong');
                    //         emotionSpan.textContent = Translator.trans('interviews.video_conference.emotion.' + emotion.emotion, {}, 'interviews') + ': ' + (emotion.score * 100).toFixed(0) + '%';
                    //         emotionDiv.appendChild(emotionSpan);
                    //     }
                    //
                    //     // Just first emotion
                    //     // if (face.emotion[0].score > 0.3) {
                    //     //     switch (face.emotion[0].emotion) {
                    //     //         case 'angry':
                    //     //             emotionDiv.textContent = '😠';
                    //     //             break;
                    //     //         case 'disgust':
                    //     //             emotionDiv.textContent = '😖';
                    //     //             break;
                    //     //         case 'fear':
                    //     //             emotionDiv.textContent = '😱';
                    //     //             break;
                    //     //         case 'happy':
                    //     //             emotionDiv.textContent = '😀';
                    //     //             break;
                    //     //         case 'sad':
                    //     //             emotionDiv.textContent = '🙁';
                    //     //             break;
                    //     //         case 'surprise':
                    //     //             emotionDiv.textContent = '😮';
                    //     //             break;
                    //     //         case 'neutral':
                    //     //             emotionDiv.textContent = '😐';
                    //     //             break;
                    //     //         default:
                    //     //             emotionDiv.textContent = '';
                    //     //             break;
                    //     //     }
                    //     // }
                    // }
                }

        }
    });

    conn.on('close', () => {
        for (let i = 0; i < connections.length; i++) {
            if (connections[i] === conn) {
                connections.splice(i, 1);
                break;
            }
        }
    });
}

// Get webcam stream
async function getLocalStream(force = false) {
    if (!force && localStream) {
        return localStream;
    }
    try {
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    deviceId: videoDeviceId ? {exact: videoDeviceId} : undefined
                },
                audio: {
                    deviceId: audioDeviceId ? {exact: audioDeviceId} : undefined
                },
            });
        } catch (error) {
            if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                // Retry with audio-only if no video device is found
                try {
                    document.querySelectorAll('.js-background-blur-btn').forEach((el) => el.style.display = 'none');
                    document.querySelectorAll('.js-mute-video-btn').forEach((el) => el.style.display = 'none');
                    stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            deviceId: audioDeviceId ? {exact: audioDeviceId} : undefined
                        },
                    });
                } catch (audioError) {
                    alert(Translator.trans('interviews.video_conference.device_missing', {}, 'interviews'));
                    return null;
                }
            } else {
                alert(Translator.trans('interviews.video_conference.permission_error', {}, 'interviews'));
                return null;
            }
        }

        if (IS_MOBILE) {
            localStream = stream;
            localVideo.srcObject = stream;
            videoPreview.srcObject = stream;
            displayVolumeLevel(stream);
            setInterval(() => {detectVideoEmotions();}, 250);
            return localStream;
        }

        try {
            // Emotion detection inside, because video is modified
            let processedStream = blurBackground(stream);

            localStream = processedStream;
            localVideo.srcObject = processedStream;
            videoPreview.srcObject = processedStream;
            displayVolumeLevel(processedStream);
            return localStream;
        } catch (error) {
            console.error('Error while blurring background', error);
            localStream = stream;
            localVideo.srcObject = localStream;
            videoPreview.srcObject = localStream;
            displayVolumeLevel(localStream);
            setInterval(() => {detectVideoEmotions();}, 250);
            return localStream;
        }


    } catch (error) {
        console.error('Error while getting media devices', error);
    }
}

function updateLocalViewSize() {
    let streamCount = document.querySelectorAll('#video_container .stream-container').length;
    document.getElementById('local_view').classList.toggle('mini-self-video', (streamCount > 0 && streamCount <= 4));
    if (streamCount === 0) {
        // Stop transcribing when not in conversation
        stopTranscribing();
    } else {
        // Only transcribe when both candidate (trainee/guest) and interviewer are in conversation
        startTranscribing();
    }
}

//Disable screen sharing button on unsupported browsers
if (!(navigator.mediaDevices.getDisplayMedia instanceof Function)) {
    document.getElementById('toggle_screen_share').style.display = 'none';
}

function screenShare() {
    if (calls.length > 0) {
        if (screenStream) {
            // End screen share
            screenStream.getTracks().forEach(track => track.stop());
            screenStream = null;
            return;
        }
        navigator.mediaDevices.getDisplayMedia({video: true}).then(stream => {
            screenStream = stream;
            calls.forEach((call) => {
                console.log('adding screen share to call', call);
                if (!call || !call.open || !call.peerConnection) {
                    return;
                }

                // screenStream.getTracks().forEach(track => call.peerConnection.addTransceiver(track, {streams: [stream]}));
                screenShareCalls.push(peer.call(call.peer, screenStream, {
                    metadata: { type: 'screenShare' }
                }));
            });
            stream.getVideoTracks()[0].addEventListener('ended', () => {
                screenStream = null;
                screenShareCalls.forEach((call) => call.close());
                screenShareCalls = [];
            });
        });
    }
}

function toggleChat() {
    if (!isChatViewOpen()) {
        $("#chat_container").toggleClass('open', true);
        if (!document.hidden) {
            // $("#chat-tag").hide();
            // $("#chat-tag").empty();
            unreadMessageCounter = 0;
            document.title = originalPageTitle;
        }

    } else {
        $("#chat_container").toggleClass('open', false);
    }
}

function isChatViewOpen() {
    return $('#chat_container').hasClass('open');
}

document.getElementById('chat-file-input').onchange = function () {
    let selectedFilesDiv = document.getElementById('chat_selected_files');
    document.querySelectorAll('#chat_selected_files .selected-file').forEach(e => e.remove());
    const files = this.files;
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileDiv = document.createElement('div');
        fileDiv.classList.add('selected-file');
        fileDiv.innerHTML = `<i class="fa fa-paperclip"></i> ${file.name}`;
        selectedFilesDiv.appendChild(fileDiv);
    }
};

document.getElementById('chat_clear_attachments').onclick = function () {
    document.querySelectorAll('#chat_selected_files .selected-file').forEach(e => e.remove());
    document.getElementById('chat_file_input').value = "";
};

document.querySelector('#chat-form').onsubmit = function(e) {
    e.preventDefault();
    var text = document.getElementById("chat-text-area").value;
    var files = document.getElementById('chat-file-input').files;

    if (/<[a-z][\s\S]*>/i.test(text)) {
        text = "'" + text + "'";
    }
    if (text !== "") {
        createChatText(text, true);
        document.getElementById("chat-text-area").value = "";
        for (let i = 0; i < connections.length; i++) {
            connections[i].send({
                type: 'message',
                sender: userName,
                message: text
            });
        }
    }

    if (files.length > 0) {
        for (let i = 0; i < files.length; i++) {
            text = '<i class="fa fa-paperclip"></i> ' + files[i].name;
            createFileDownloadLink(null, files[i].name, true);
            for (let i = 0; i < connections.length; i++) {
                connections[i].send({
                    type: 'file',
                    sender: userName,
                    blob: files[i],
                    name: files[i].name,
                    fileType: files[i].type,
                    size: files[i].size
                });
            }
        }
        document.getElementById("chat-file-input").value = "";
        document.getElementById("chat-file-input").onchange();
    }
};
document.querySelector('#chat-form #chat-text-area').onkeyup = function(e) {
    if (e.keyCode === 13 && !e.shiftKey) {
        this.form.onsubmit(e);
    }
};
function createChatText(text, self = false, sender = null, append = true) {
    urlRegex = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,4}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)/g;

    if (sender === null && self) {
        sender = Translator.trans('base.you', {}, 'messages');
    }

    let chatMessage = document.createElement("li");
    chatMessage.classList.add('message');
    if (self) {
        chatMessage.classList.add('self');
    }

    let author = document.createElement("div");
    author.classList.add("author");
    author.textContent = sender;

    let chatBody = document.createElement("div");
    chatBody.classList.add("chat-body");
    chatBody.textContent = text;

    if (urlRegex.test(text)) {
        chatBody.innerHTML = chatBody.innerHTML.replace(urlRegex, '<a href="$&" target="_blank">$&</a>');
    }

    chatMessage.appendChild(author);
    chatMessage.appendChild(chatBody);

    if (document.hidden) {
        unreadMessageCounter++;
        let newMessagesText = Translator.transChoice(
            'interviews.video_conference.new_message_counter',
            unreadMessageCounter,
            {'%count%': unreadMessageCounter},
            'interviews'
        );

        document.title = `${newMessagesText} - ${originalPageTitle}`;
    }
    if (!isChatViewOpen()) {
        // unreadMessageCounter++;
        // $("#chat-tag").html(unreadMessageCounter);
        // $("#chat-tag").show();
        toggleChat();
        showToolbar(2000);
    }
    let chatContainer = document.querySelector("#chat-message");
    chatContainer.appendChild(chatMessage);
    document.querySelector('#chat_container .items-list').scrollTop = chatContainer.scrollHeight;
}

function createFileDownloadLink(blob, fileName, self = false, sender = null, append = true) {
    if (sender === null && self) {
        sender = Translator.trans('base.you', {}, 'messages');
    }

    let chatMessage = document.createElement("li");
    chatMessage.classList.add('message');
    if (self) {
        chatMessage.classList.add('self');
    }

    let author = document.createElement("div");
    author.classList.add("author");
    author.textContent = sender;

    let chatBody = document.createElement("div");
    chatBody.classList.add("chat-body");
    let icon = document.createElement("i");
    icon.classList.add("fa");
    icon.classList.add("fa-paperclip");
    chatBody.appendChild(icon);
    if (self) {
        chatBody.appendChild(document.createTextNode(fileName));
    } else {
        let link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = fileName;
        link.textContent = fileName;
        chatBody.appendChild(link);
    }

    chatMessage.appendChild(author);
    chatMessage.appendChild(chatBody);

    if (document.hidden) {
        unreadMessageCounter++;
        let newMessagesText = Translator.transChoice(
            'interviews.video_conference.new_message_counter',
            unreadMessageCounter,
            {'%count%': unreadMessageCounter},
            'interviews'
        );

        document.title = `${newMessagesText} - ${originalPageTitle}`;
    }
    if (!isChatViewOpen()) {
        // unreadMessageCounter++;
        // $("#chat-tag").html(unreadMessageCounter);
        // $("#chat-tag").show();
        toggleChat();
        showToolbar(2000);
    }
    let chatContainer = document.querySelector("#chat-message");
    chatContainer.appendChild(chatMessage);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function createSystemMessage(text) {
    let template =
        '<li class="system-message">' + text + "</li>";

    let chatMessage = document.getElementById("chat-message");
    $(template).appendTo(chatMessage);
    document.querySelector('#chat_container .items-list').scrollTop = chatMessage.scrollHeight;
}

document.addEventListener("visibilitychange", function() {
    if (!document.hidden) {
        if (isChatViewOpen()) {
            unreadMessageCounter = 0;
            document.title = originalPageTitle;
        }
    }
});

function muteVideo() {
    let buttons = document.querySelectorAll('.js-mute-video-btn');
    if (localStream && localStream.getVideoTracks()[0]) {
        if (localStream.getVideoTracks()[0].enabled) {
            localStream.getVideoTracks()[0].enabled = false;
            buttons.forEach((btn) => btn.classList.add('active'));
        } else {
            localStream.getVideoTracks()[0].enabled = true;
            buttons.forEach((btn) => btn.classList.remove('active'));
        }
    }
}

function muteAudio() {
    let buttons = document.querySelectorAll('js-mute-audio-btn');
    if (localStream && localStream.getAudioTracks()[0]) {
        if (localStream.getAudioTracks()[0].enabled) {
            localStream.getAudioTracks()[0].enabled = false;
            buttons.forEach((btn) => btn.classList.add('active'));
        } else {
            localStream.getAudioTracks()[0].enabled = true;
            buttons.forEach((btn) => btn.classList.remove('active'));
        }
    }
}

function toggleEmotionDetection(force = false) {
    emotionDetectionEnabled = !emotionDetectionEnabled || force;
    if (emotionDetectionEnabled) {
        document.querySelectorAll('.js-emotion-detection-btn').forEach((btn) => btn.classList.add('active'));
    } else {
        document.querySelectorAll('.stream-container .emotion').forEach(e => e.textContent = '');
        document.querySelectorAll('.js-emotion-detection-btn').forEach((btn) => btn.classList.remove('active'));
    }
}

function toggleBackgroundBlur() {
    backgroundBlurEnabled = !backgroundBlurEnabled;
    if (backgroundBlurEnabled) {
        document.querySelectorAll('.js-background-blur-btn').forEach((btn) => btn.classList.add('active'));
    } else {
        document.querySelectorAll('.js-background-blur-btn').forEach((btn) => btn.classList.remove('active'));
    }
}

document.getElementById('disconnect_call').onclick = function () {
    peer.disconnect();
    window.location.href = Routing.generate('video_conference_evaluate_room', {'room': ROOM_ID});
};

window.onbeforeunload = function () {
    // Replaced with heartbeat
    // navigator.sendBeacon(Routing.generate('video_conference_disconnect_room', {'room': ROOM_ID}));
};

// Heartbeat
setInterval(() => {
    navigator.sendBeacon(Routing.generate('video_conference_heart_beat', {'room': ROOM_ID}));
}, 60000);

let idleTimer = null;
let idleState = false;

function showToolbar(time) {
    clearTimeout(idleTimer);
    if (idleState === true) {
        $(".conference-container .toolbar-buttons").removeClass("transparent");
    }
    idleState = false;
    idleTimer = setTimeout(function() {
        $(".conference-container .toolbar-buttons").addClass("transparent");
        idleState = true;
    }, time);
}

showToolbar(2000);

$(window).mousemove(function(){
    showToolbar(5000);
});

$(window).on('touchmove', function() {
    showToolbar(5000);
});

//Invite participant
function inviteParticipant() {
    const inviteModal = document.querySelector('#invite_modal');
    const inviteFormContainer = document.querySelector('#invite_modal .js-form-container');

    $(inviteModal).on('hidden.bs.modal', function () {
        $(inviteFormContainer).empty();
    });

    $(inviteFormContainer).load(Routing.generate('video_conference_invite', {'room': ROOM_ID}), function onFormLoad() {
        let $form =$('form', inviteModal);
        $form.submit(function(event) {
            event.preventDefault();

            $('[type="submit"] .fa-spinner', inviteFormContainer).show();
            $.ajax({
                type: 'POST',
                url: this.action,
                dataType: 'json',
                data: new FormData(this),
                contentType: false,
                processData: false,
                success: function (res) {
                    $('[type="submit"] .fa-spinner', inviteFormContainer).hide();
                    if (res.success) {
                        $(inviteModal).modal('hide');
                        toastr.success(res.message, null, {
                            positionClass: 'toast-top-center',
                            timeOut: 4000
                        });
                    }
                },
                error: function (res) {
                    $(inviteFormContainer).html(res.responseText);
                    onFormLoad();
                }
            });
        });
    });
    $(inviteModal).modal('show');
}

function refreshInterviewerQuestions(refresh = false) {
    if (!document.getElementById('question_list')) {
        return;
    }
    questionLoadTries++;
    document.querySelector('#question_refresh_button i').classList.add('fa-spin');
    let params = {
        'room': ROOM_ID
    };
    if (refresh) {
        params.refresh = true;
    }
    fetch(Routing.generate('video_conference_get_interviewer_questions', params))
        .then(async (data)  => {
            let response = await data.json();
            if (response.success && response.questions) {
                questionLoadTries = 0;
                document.getElementById('question_list').innerHTML = '';
                for (let i = 0; i < response.questions.length; i++) {
                    const questionSpan = document.createElement('div');
                    questionSpan.classList.add('item');
                    if (i === 0) {
                        questionSpan.classList.add('active');
                    }
                    questionSpan.innerText = response.questions[i].question;
                    document.getElementById('question_list').appendChild(questionSpan);
                    questionSpan.addEventListener('click', () => {
                        document.getElementById('chat-text-area').value = this.innerText;
                        document.getElementById('chat-text-area').focus();
                        let next = this.nextElementSibling || this.parentElement.firstChild;
                        if (next) {
                            next.classList.add('active');
                            this.remove();
                        }
                    });
                }
            } else {
                if (questionLoadTries < 2 && data.status === 503) {
                    refreshInterviewerQuestions(true);
                    return;
                } else {
                    document.querySelector('.question-container').remove();
                }
            }
            document.querySelector('#question_refresh_button i').classList.remove('fa-spin');
        })
        .catch(function (error) {
            document.querySelector('.question-container').remove();
        });
}

async function startTranscribing() {
    if (!TRANSCRIPTION_ENABLED) {
        return;
    }
    if (isTranscribing) {
        return;
    }
    if (!localStream || !localStream.getAudioTracks()[0]) {
        return;
    }
    let speakingStartTime = null;
    let lastSpeakingStartTime = null;

    // Microphone audio
    let stream = new MediaStream(localStream.getAudioTracks());

    // Fake audio
    if (fakeAudioFile) {
        let audioElement = new Audio('/uploads/content/' + fakeAudioFile);

        // Play the audio and wait until it actually starts playing
        await new Promise((resolve) => {
            audioElement.addEventListener('playing', resolve);
            audioElement.play();  // Starts playing the audio
        });

        // Once playing, capture the stream (if supported)
        stream = audioElement.captureStream ? audioElement.captureStream() : audioElement.mozCaptureStream();
    }


    myVoiceActivityDetector = await vad.MicVAD.new({
        positiveSpeechThreshold: 0.8,
        minSpeechFrames: 3,
        preSpeechPadFrames: 10,
        redemptionFrames: 10,
        stream: stream,
        onSpeechStart: () => {
            speakingStartTime = Date.now();
            console.log('speech start');
        },
        onSpeechEnd: (audioChunks) => {
            console.log('speech end');
            lastSpeakingStartTime = speakingStartTime;
            speakingStartTime = null;
            const formData = new FormData();
            // Convert Float32Array to a Blob (just raw data for now)
            const blob = new Blob([vad.utils.encodeWAV(audioChunks)], {type: 'audio/wav'});

            if (urlParams.has('debug')) {
                // Add audio to the chat
                const audioElement = document.createElement('audio');
                audioElement.src = URL.createObjectURL(blob);
                audioElement.controls = true;
                document.getElementById('chat-message').appendChild(audioElement);
            }

            const startTimestamp = toUnixTimestamp(lastSpeakingStartTime);
            const endTimestamp = toUnixTimestamp(Date.now());
            formData.append('audio', blob);
            formData.append('startTimestamp', startTimestamp);
            formData.append('endTimestamp', endTimestamp);
            formData.append('emotions', JSON.stringify(averageEmotionsForSnippet(startTimestamp, endTimestamp)));

            fetch(Routing.generate('video_conference_upload_room_audio', {'room': ROOM_ID}), {
                method: 'POST',
                body: formData
            })
                .then(response => response.json())
                .then(data => console.log('Transcription:', data.transcription))
                .catch(error => console.error('Error:', error));
        }
    });
    myVoiceActivityDetector.start();
    isTranscribing = true;
}

function stopTranscribing() {
    if (isTranscribing) {
        isTranscribing = false;
        if (myVoiceActivityDetector) {
            myVoiceActivityDetector.destroy();
            myVoiceActivityDetector = null;
        }
    }
}

function displayVolumeLevel(stream) {
    if (!stream || !stream.getAudioTracks()[0]) {
        return;
    }
    let max_level_L = 0;
    let old_level_L = 0;
    let vol_canvas = document.getElementById("volume_meter");
    let vol_canvas_context = vol_canvas.getContext("2d");

    let audioContext = new AudioContext();
    let microphone = audioContext.createMediaStreamSource(stream);
    volumeMeterProcessor = audioContext.createScriptProcessor(1024, 1, 1);

    microphone.connect(volumeMeterProcessor);
    volumeMeterProcessor.connect(audioContext.destination);
    volumeMeterProcessor.onaudioprocess = function(event){

        let inpt_L = event.inputBuffer.getChannelData(0);
        let instant_L = 0.0;

        let sum_L = 0.0;
        for(let i = 0; i < inpt_L.length; ++i) {
            sum_L += inpt_L[i] * inpt_L[i];
        }
        instant_L = Math.sqrt(sum_L / inpt_L.length);
        max_level_L = Math.max(max_level_L, instant_L);
        instant_L = Math.max( instant_L, old_level_L -0.008 );
        old_level_L = instant_L;


        // Clear the canvas
        vol_canvas_context.clearRect(0, 0, vol_canvas.width, vol_canvas.height);
        // Draw speaker icon
        vol_canvas_context.font = '16px FontAwesome';
        vol_canvas_context.fillStyle = '#000000';
        vol_canvas_context.fillText('\uf130', 8, 20);
        vol_canvas_context.fillStyle = '#00ff00';

        // Calculate the height of the fill
        let meterHeight = (vol_canvas.height - 30) * (instant_L / max_level_L);
        let yPosition = vol_canvas.height - 10 - meterHeight;

        // Draw the volume meter upwards
        vol_canvas_context.fillRect(10, yPosition, vol_canvas.width - 20, meterHeight);
    };
}

function stopDisplayingVolumeLevel() {
    if (volumeMeterProcessor) {
        volumeMeterProcessor.disconnect();
    }
}

/*******************************************
* Emotion Detection
*******************************************/
human.events.addEventListener('detect', () => {
    let interpolated = human.result;
    emotionDetectionQueueCount--;
    let results = {
        timestamp: toUnixTimestamp(Date.now()),
    };
    let faces = [];
    if (interpolated.persons && interpolated.persons.length > 0) {
        // for (const person of interpolated.persons) {
        //     faces.push(person.face);
        // }
        // Just get the first person
        results.emotions = interpolated.persons[0].face.emotion;
    } else if (interpolated.face && interpolated.face.length > 0) {
        // faces = interpolated.face;
        results.emotions = interpolated.face[0].emotion;
    } else {
        // No faces detected
        return;
    }

    // for (let i = 0; i < faces.length; i++) {
    //     if (faces[i].emotion.length === 0) {
    //         continue;
    //     }
    //     results['face_' + (i + 1) + '_emotions'] = faces[i].emotion;
    // }
    emotionTimeline.push(results);

    for (let i = 0; i < connections.length; i++) {
        connections[i].send({
            type: 'emotion',
            sender: userName,
            data: results
        });
    }

});

function detectFrameEmotions(videoFrame) {
    if (!EMOTION_DETECTION_ENABLED) {
        return;
    }
    if (!isTranscribing) {
        return;
    }

    // If queque is not empty then drop this frame
    if (emotionDetectionQueueCount > 0) {
        return;
    }

    emotionDetectionQueueCount++;

    createImageBitmap(videoFrame)
        .then((imageBitmap) => {
            human.detect(imageBitmap); // See human detect event listener
        })
        .catch((error) => {
            console.log(error);
        });
}

function detectVideoEmotions() {
    if (!EMOTION_DETECTION_ENABLED) {
        return;
    }
    if (!isTranscribing) {
        return;
    }

    if (emotionDetectionQueueCount > 0) {
        return;
    }

    if (!localStream || !localStream.getVideoTracks()[0]) {
        return;
    }

    emotionDetectionQueueCount++;

    human.detect(localVideo);
}

function averageEmotionsForSnippet(startTimestamp, endTimestamp) {
    let emotionSummary = {};

    emotionTimeline.forEach(emotionStamp => {
        if (emotionStamp.timestamp >= startTimestamp && emotionStamp.timestamp <= endTimestamp) {
            for (const emotionStampElement of emotionStamp.emotions) {
                if (!emotionSummary[emotionStampElement.emotion]) {
                    emotionSummary[emotionStampElement.emotion] = 0;
                }
                emotionSummary[emotionStampElement.emotion] += emotionStampElement.score;
            }
        }
    });

    let averageEmotions = [];
    Object.keys(emotionSummary).forEach(key => {
        averageEmotions.push({
            emotion: key,
            score: Math.round(emotionSummary[key] / emotionSummary.length * 100)+'%'
        });
    });

    // Clear emotionTimeline
    emotionTimeline = [];
    return averageEmotions;
}

function blurBackground(stream) {
    if (!stream || !stream.getVideoTracks()[0]) {
        return stream;
    }
    const streamSettings = stream.getVideoTracks()[0].getSettings();
    const canvas = new OffscreenCanvas(streamSettings.width, streamSettings.height);
    const ctx = canvas.getContext("2d");

    selfieSegmentation.onResults((results) => {
        // ctx.save();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // Correct the flipped image (horizontal flip)
        ctx.setTransform(-1, 0, 0, 1, canvas.width, 0); // Combined translate & scale
        ctx.drawImage(results.segmentationMask, 0, 0, canvas.width, canvas.height);

        // Apply blur to the background (pixels outside the segmentation)
        ctx.globalCompositeOperation = "source-out";
        ctx.filter = 'blur(5px)';  // Apply a blur effect, adjust the value as needed
        ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

        // Reset filter and apply foreground image
        ctx.filter = 'none';
        ctx.globalCompositeOperation = "destination-atop";
        ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

        // ctx.restore();
    });

    const videoTrack = stream.getVideoTracks()[0];
    const processor = new MediaStreamTrackProcessor({ track: videoTrack });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });

    let detectEmotionCountdown = 0;
    let exceptionCount = 0;
    const transformer = new TransformStream({
        async transform(videoFrame, controller) {
            // Detect emotions before processing the frame
            detectEmotionCountdown++;
            // Detect emotions every 10 frames
            if (detectEmotionCountdown === 10) {
                detectFrameEmotions(videoFrame);
                detectEmotionCountdown = 0;
            }
            if (!backgroundBlurEnabled) {
                controller.enqueue(videoFrame);
                return;
            }
            const originalFrame = videoFrame.clone();
            try {
                videoFrame.width = videoFrame.displayWidth;
                videoFrame.height = videoFrame.displayHeight;
                await selfieSegmentation.send({ image: videoFrame });
                const newFrame = new VideoFrame(canvas, { timestamp: videoFrame.timestamp });
                videoFrame.close();
                controller.enqueue(newFrame);
            } catch (error) {
                exceptionCount++;
                if (exceptionCount > 10) {
                    toggleBackgroundBlur();
                    exceptionCount = 0;
                }
                videoFrame.close();
                controller.enqueue(originalFrame);
            }
        }
    });

    processor.readable
        .pipeThrough(transformer)
        .pipeTo(generator.writable);

    const processedStream = new MediaStream();
    processedStream.addTrack(generator);
    for (const audioTrack of stream.getAudioTracks()) {
        processedStream.addTrack(audioTrack);
    }

    return processedStream;
}

function toUnixTimestamp(timestamp) {
    return Math.round(timestamp / 1000);
}