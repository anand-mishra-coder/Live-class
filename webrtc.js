// webrtc.js
// ============================================================
// LIVE CLASS WEBRTC ENGINE
// Firebase Firestore Signaling
// ============================================================

import {
    auth,
    db,
    doc,
    setDoc,
    deleteDoc,
    collection,
    addDoc,
    onSnapshot,
    query,
    serverTimestamp
} from "./firebase.js";


// ============================================================
// CONFIG
// ============================================================

const RTC_CONFIG = {
    iceServers: [
        {
            urls: "stun:stun.l.google.com:19302"
        },
        {
            urls: "stun:stun1.l.google.com:19302"
        }
    ]
};


// ============================================================
// GLOBAL STATE
// ============================================================

let localStream = null;
let localVideoElement = null;

let currentRoomId = null;
let currentUserId = null;
let isTeacher = false;

let remoteContainer = null;

let joined = false;
let cameraFacingMode = "user";

let cameraTrack = null;
let audioTrack = null;

let screenStream = null;
let isScreenSharing = false;

const peerConnections = new Map();
const remoteVideos = new Map();

const processedSignals = new Set();

let unsubscribeSignals = null;
let unsubscribeParticipants = null;


// ============================================================
// HELPERS
// ============================================================

function getCurrentUser() {
    return auth.currentUser;
}


function requireUser() {
    const user = getCurrentUser();

    if (!user) {
        throw new Error("User is not logged in.");
    }

    return user;
}


function getUserId() {
    return requireUser().uid;
}


function createRemoteVideo(userId) {

    const video = document.createElement("video");

    video.autoplay = true;
    video.playsInline = true;
    video.controls = false;

    video.dataset.userId = userId;

    video.style.width = "100%";
    video.style.height = "100%";
    video.style.objectFit = "cover";
    video.style.borderRadius = "18px";

    if (remoteContainer) {
        remoteContainer.appendChild(video);
    }

    remoteVideos.set(userId, video);

    return video;
}


function removeRemoteVideo(userId) {

    const video = remoteVideos.get(userId);

    if (video) {
        try {
            video.pause();
        } catch {}

        video.srcObject = null;
        video.remove();
    }

    remoteVideos.delete(userId);
}


function getPeerConnection(userId) {
    return peerConnections.get(userId);
}


// ============================================================
// CAMERA
// ============================================================

export async function startCamera(videoElement) {

    if (!videoElement) {
        throw new Error("Local video element not found.");
    }

    localVideoElement = videoElement;

    // Already running
    if (localStream) {

        localVideoElement.srcObject = localStream;

        try {
            await localVideoElement.play();
        } catch {}

        return localStream;
    }


    const stream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: cameraFacingMode,
            width: {
                ideal: 1280
            },
            height: {
                ideal: 720
            },
            frameRate: {
                ideal: 30
            }
        },
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    });


    localStream = stream;

    cameraTrack = stream.getVideoTracks()[0];
    audioTrack = stream.getAudioTracks()[0];


    localVideoElement.srcObject = localStream;

    try {
        await localVideoElement.play();
    } catch {}


    return localStream;
}


// ============================================================
// STOP CAMERA
// ============================================================

export function stopCamera() {

    if (!localStream) return;

    localStream.getTracks().forEach(track => {
        try {
            track.stop();
        } catch {}
    });

    localStream = null;
    cameraTrack = null;
    audioTrack = null;

    if (localVideoElement) {
        localVideoElement.srcObject = null;
    }
}


// ============================================================
// SWITCH FRONT / BACK CAMERA
// ============================================================

export async function switchCamera() {

    if (!localStream) {
        throw new Error("Camera is not started.");
    }


    const newFacingMode =
        cameraFacingMode === "user"
            ? "environment"
            : "user";


    let newStream;

    try {

        newStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: {
                    exact: newFacingMode
                },
                width: {
                    ideal: 1280
                },
                height: {
                    ideal: 720
                },
                frameRate: {
                    ideal: 30
                }
            },
            audio: false
        });

    } catch {

        // Some devices don't support exact facingMode
        newStream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: newFacingMode,
                width: {
                    ideal: 1280
                },
                height: {
                    ideal: 720
                }
            },
            audio: false
        });
    }


    const newVideoTrack = newStream.getVideoTracks()[0];

    const oldVideoTrack = cameraTrack;


    cameraFacingMode = newFacingMode;
    cameraTrack = newVideoTrack;


    // Replace video track in every PeerConnection
    for (const pc of peerConnections.values()) {

        const sender = pc
            .getSenders()
            .find(s =>
                s.track &&
                s.track.kind === "video"
            );

        if (sender) {

            try {
                await sender.replaceTrack(newVideoTrack);
            } catch (error) {
                console.warn(
                    "Unable to replace camera track:",
                    error
                );
            }
        }
    }


    // Replace local stream track
    if (localStream) {

        localStream.removeTrack(oldVideoTrack);
        localStream.addTrack(newVideoTrack);
    }


    if (localVideoElement) {

        localVideoElement.srcObject = localStream;

        try {
            await localVideoElement.play();
        } catch {}
    }


    if (oldVideoTrack) {
        try {
            oldVideoTrack.stop();
        } catch {}
    }


    return cameraFacingMode;
}


// ============================================================
// MUTE / UNMUTE MICROPHONE
// ============================================================

export function toggleMute() {

    if (!audioTrack && localStream) {
        audioTrack = localStream.getAudioTracks()[0];
    }

    if (!audioTrack) {
        return false;
    }


    audioTrack.enabled = !audioTrack.enabled;

    return !audioTrack.enabled;
}


// ============================================================
// CAMERA ON / OFF
// ============================================================

export function toggleCamera() {

    if (!cameraTrack && localStream) {
        cameraTrack = localStream.getVideoTracks()[0];
    }

    if (!cameraTrack) {
        return false;
    }


    cameraTrack.enabled = !cameraTrack.enabled;

    return !cameraTrack.enabled;
}


// ============================================================
// SCREEN SHARE
// ============================================================

export async function startScreenShare() {

    if (isScreenSharing) {
        return screenStream;
    }


    if (!navigator.mediaDevices.getDisplayMedia) {
        throw new Error(
            "Screen sharing is not supported on this browser."
        );
    }


    screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
            frameRate: {
                ideal: 30
            }
        },
        audio: true
    });


    const screenTrack = screenStream.getVideoTracks()[0];

    if (!screenTrack) {
        throw new Error("Screen track unavailable.");
    }


    // Replace outgoing video track
    for (const pc of peerConnections.values()) {

        const sender = pc
            .getSenders()
            .find(s =>
                s.track &&
                s.track.kind === "video"
            );

        if (sender) {

            try {
                await sender.replaceTrack(screenTrack);
            } catch (error) {
                console.warn(
                    "Screen share replaceTrack failed:",
                    error
                );
            }
        }
    }


    isScreenSharing = true;


    // When browser's "Stop sharing" button is pressed
    screenTrack.onended = async () => {

        try {
            await stopScreenShare();
        } catch (error) {
            console.error(error);
        }
    };


    return screenStream;
}


// ============================================================
// STOP SCREEN SHARE
// ============================================================

export async function stopScreenShare() {

    if (!screenStream) {
        return;
    }


    const screenTrack = screenStream.getVideoTracks()[0];

    // Restore camera
    if (cameraTrack) {

        for (const pc of peerConnections.values()) {

            const sender = pc
                .getSenders()
                .find(s =>
                    s.track &&
                    s.track.kind === "video"
                );

            if (sender) {

                try {
                    await sender.replaceTrack(cameraTrack);
                } catch (error) {
                    console.warn(
                        "Camera restore failed:",
                        error
                    );
                }
            }
        }
    }


    screenStream.getTracks().forEach(track => {

        try {
            track.stop();
        } catch {}

    });


    screenStream = null;
    isScreenSharing = false;


    if (localVideoElement && localStream) {

        localVideoElement.srcObject = localStream;

        try {
            await localVideoElement.play();
        } catch {}
    }
}


// ============================================================
// CREATE PEER CONNECTION
// ============================================================

async function createPeerConnection(remoteUserId) {

    if (peerConnections.has(remoteUserId)) {
        return peerConnections.get(remoteUserId);
    }


    const pc = new RTCPeerConnection(RTC_CONFIG);


    peerConnections.set(
        remoteUserId,
        pc
    );


    // --------------------------------------------------------
    // Add local tracks
    // --------------------------------------------------------

    if (localStream) {

        localStream.getTracks().forEach(track => {

            try {
                pc.addTrack(
                    track,
                    localStream
                );
            } catch (error) {
                console.warn(
                    "Unable to add local track:",
                    error
                );
            }

        });
    }


    // --------------------------------------------------------
    // Receive remote tracks
    // --------------------------------------------------------

    pc.ontrack = event => {

        let video = remoteVideos.get(remoteUserId);

        if (!video) {
            video = createRemoteVideo(remoteUserId);
        }


        if (event.streams && event.streams[0]) {

            video.srcObject = event.streams[0];

        } else {

            let stream = video.srcObject;

            if (!stream) {
                stream = new MediaStream();
                video.srcObject = stream;
            }

            stream.addTrack(event.track);
        }


        video.play().catch(() => {});
    };


    // --------------------------------------------------------
    // ICE candidate
    // --------------------------------------------------------

    pc.onicecandidate = async event => {

        if (!event.candidate) {
            return;
        }


        try {

            const signalsRef = collection(
                db,
                "liveClasses",
                currentRoomId,
                "signals"
            );


            await addDoc(signalsRef, {

                type: "candidate",

                from: currentUserId,

                to: remoteUserId,

                candidate:
                    event.candidate.toJSON(),

                createdAt:
                    serverTimestamp()

            });

        } catch (error) {

            console.error(
                "ICE candidate error:",
                error
            );
        }
    };


    // --------------------------------------------------------
    // Connection state
    // --------------------------------------------------------

    pc.onconnectionstatechange = () => {

        const state = pc.connectionState;

        console.log(
            `Connection ${remoteUserId}:`,
            state
        );


        if (state === "failed") {

            console.warn(
                "Peer connection failed:",
                remoteUserId
            );

            try {
                pc.restartIce();
            } catch {}
        }


        if (state === "closed") {

            removeRemoteVideo(
                remoteUserId
            );

            peerConnections.delete(
                remoteUserId
            );
        }
    };


    pc.oniceconnectionstatechange = () => {

        console.log(
            `ICE ${remoteUserId}:`,
            pc.iceConnectionState
        );

    };


    return pc;
}


// ============================================================
// SEND SIGNAL
// ============================================================

async function sendSignal(data) {

    const signalsRef = collection(
        db,
        "liveClasses",
        currentRoomId,
        "signals"
    );


    await addDoc(
        signalsRef,
        {
            ...data,

            createdAt:
                serverTimestamp()
        }
    );
}


// ============================================================
// TEACHER CREATE OFFER
// ============================================================

async function createOfferForStudent(studentId) {

    try {

        const pc =
            await createPeerConnection(studentId);


        const offer =
            await pc.createOffer();


        await pc.setLocalDescription(
            offer
        );


        await sendSignal({

            type: "offer",

            from: currentUserId,

            to: studentId,

            sdp: {
                type: offer.type,
                sdp: offer.sdp
            }

        });

    } catch (error) {

        console.error(
            "Offer creation failed:",
            error
        );
    }
}


// ============================================================
// HANDLE OFFER
// ============================================================

async function handleOffer(signal) {

    const fromUserId = signal.from;


    const pc =
        await createPeerConnection(
            fromUserId
        );


    await pc.setRemoteDescription(
        new RTCSessionDescription(
            signal.sdp
        )
    );


    const answer =
        await pc.createAnswer();


    await pc.setLocalDescription(
        answer
    );


    await sendSignal({

        type: "answer",

        from: currentUserId,

        to: fromUserId,

        sdp: {
            type: answer.type,
            sdp: answer.sdp
        }

    });
}


// ============================================================
// HANDLE ANSWER
// ============================================================

async function handleAnswer(signal) {

    const pc =
        peerConnections.get(
            signal.from
        );


    if (!pc) {
        return;
    }


    try {

        await pc.setRemoteDescription(
            new RTCSessionDescription(
                signal.sdp
            )
        );

    } catch (error) {

        console.warn(
            "Answer handling failed:",
            error
        );
    }
}


// ============================================================
// HANDLE ICE CANDIDATE
// ============================================================

async function handleCandidate(signal) {

    const pc =
        peerConnections.get(
            signal.from
        );


    if (!pc) {
        return;
    }


    try {

        await pc.addIceCandidate(
            new RTCIceCandidate(
                signal.candidate
            )
        );

    } catch (error) {

        console.warn(
            "ICE candidate failed:",
            error
        );
    }
}


// ============================================================
// SIGNALING LISTENER
// ============================================================

function listenForSignals() {

    if (unsubscribeSignals) {
        unsubscribeSignals();
        unsubscribeSignals = null;
    }


    const signalsRef = collection(
        db,
        "liveClasses",
        currentRoomId,
        "signals"
    );


    unsubscribeSignals =
        onSnapshot(
            signalsRef,
            async snapshot => {

                for (const change of snapshot.docChanges()) {

                    if (
                        change.type !== "added"
                    ) {
                        continue;
                    }


                    const signalDoc =
                        change.doc;


                    const signal =
                        signalDoc.data();


                    // Ignore own signals
                    if (
                        signal.from ===
                        currentUserId
                    ) {
                        continue;
                    }


                    // Ignore signals not meant for us
                    if (
                        signal.to &&
                        signal.to !==
                        currentUserId
                    ) {
                        continue;
                    }


                    // Avoid processing twice
                    if (
                        processedSignals.has(
                            signalDoc.id
                        )
                    ) {
                        continue;
                    }


                    processedSignals.add(
                        signalDoc.id
                    );


                    try {

                        switch (signal.type) {

                            case "offer":

                                if (!isTeacher) {

                                    await handleOffer(
                                        signal
                                    );

                                }

                                break;


                            case "answer":

                                if (isTeacher) {

                                    await handleAnswer(
                                        signal
                                    );

                                }

                                break;


                            case "candidate":

                                await handleCandidate(
                                    signal
                                );

                                break;
                        }

                    } catch (error) {

                        console.error(
                            "Signal processing error:",
                            error
                        );
                    }
                }

            },
            error => {

                console.error(
                    "Signal listener error:",
                    error
                );

            }
        );
}


// ============================================================
// PARTICIPANT REGISTRATION
// ============================================================

async function registerParticipant() {

    const participantRef = doc(
        db,
        "liveClasses",
        currentRoomId,
        "participants",
        currentUserId
    );


    await setDoc(
        participantRef,
        {

            uid:
                currentUserId,

            name:
                getCurrentUser().displayName ||
                "Student",

            photoURL:
                getCurrentUser().photoURL ||
                "",

            role:
                isTeacher
                    ? "teacher"
                    : "student",

            mic:
                true,

            camera:
                true,

            joinedAt:
                serverTimestamp()

        },
        {
            merge: true
        }
    );
}


// ============================================================
// WATCH PARTICIPANTS
// ============================================================

function watchParticipants() {

    if (unsubscribeParticipants) {

        unsubscribeParticipants();

        unsubscribeParticipants = null;
    }


    const participantsRef =
        collection(
            db,
            "liveClasses",
            currentRoomId,
            "participants"
        );


    unsubscribeParticipants =
        onSnapshot(
            participantsRef,
            snapshot => {

                if (!isTeacher) {
                    return;
                }


                snapshot.docChanges()
                    .forEach(change => {

                        const participantId =
                            change.doc.id;


                        if (
                            participantId ===
                            currentUserId
                        ) {
                            return;
                        }


                        if (
                            change.type ===
                            "added"
                        ) {

                            createOfferForStudent(
                                participantId
                            );

                        }


                        if (
                            change.type ===
                            "removed"
                        ) {

                            const pc =
                                peerConnections.get(
                                    participantId
                                );


                            if (pc) {
                                pc.close();
                            }


                            peerConnections.delete(
                                participantId
                            );


                            removeRemoteVideo(
                                participantId
                            );
                        }

                    });

            },
            error => {

                console.error(
                    "Participant listener error:",
                    error
                );

            }
        );
}


// ============================================================
// JOIN ROOM
// ============================================================

export async function joinRoom(
    roomId,
    teacher = false,
    container = null,
    localVideo = null
) {

    if (!roomId) {
        throw new Error(
            "Room ID is required."
        );
    }


    if (joined) {

        console.warn(
            "Already joined a live room."
        );

        return;
    }


    const user = requireUser();


    currentRoomId =
        roomId;

    currentUserId =
        user.uid;

    isTeacher =
        teacher === true;

    remoteContainer =
        container || null;

    localVideoElement =
        localVideo || null;


    // Start camera if a local video element is supplied
    if (localVideoElement) {

        try {

            await startCamera(
                localVideoElement
            );

        } catch (error) {

            console.warn(
                "Camera start failed:",
                error
            );

            // Continue in audio-only mode
            try {

                const audioOnly =
                    await navigator.mediaDevices
                        .getUserMedia({
                            audio: true
                        });


                localStream =
                    audioOnly;

                audioTrack =
                    audioOnly.getAudioTracks()[0];

            } catch (audioError) {

                console.error(
                    "Microphone also unavailable:",
                    audioError
                );
            }
        }
    }


    await registerParticipant();


    listenForSignals();


    if (isTeacher) {
        watchParticipants();
    }


    joined = true;


    console.log(
        `Joined room ${roomId} as ${
            isTeacher
                ? "teacher"
                : "student"
        }`
    );


    return {
        roomId,
        uid: currentUserId,
        isTeacher
    };
}


// ============================================================
// UPDATE PARTICIPANT STATUS
// ============================================================

export async function updateParticipantStatus(
    data = {}
) {

    if (!currentRoomId || !currentUserId) {
        return;
    }


    const participantRef =
        doc(
            db,
            "liveClasses",
            currentRoomId,
            "participants",
            currentUserId
        );


    await setDoc(
        participantRef,
        data,
        {
            merge: true
        }
    );
}


// ============================================================
// GET LOCAL STREAM
// ============================================================

export function getLocalStream() {
    return localStream;
}


// ============================================================
// GET SCREEN SHARE STATE
// ============================================================

export function getScreenShareState() {
    return isScreenSharing;
}


// ============================================================
// GET MICROPHONE STATE
// ============================================================

export function isMuted() {

    if (!audioTrack) {
        return false;
    }

    return !audioTrack.enabled;
}


// ============================================================
// GET CAMERA STATE
// ============================================================

export function isCameraOff() {

    if (!cameraTrack) {
        return false;
    }

    return !cameraTrack.enabled;
}


// ============================================================
// LEAVE ROOM
// ============================================================

export async function leaveRoom() {

    if (!currentRoomId || !currentUserId) {
        return;
    }


    // Stop screen share first
    try {
        await stopScreenShare();
    } catch {}


    // Close every peer connection
    for (
        const [
            userId,
            pc
        ] of peerConnections
    ) {

        try {
            pc.close();
        } catch {}


        removeRemoteVideo(
            userId
        );
    }


    peerConnections.clear();


    // Stop local media
    stopCamera();


    // Remove participant
    try {

        const participantRef =
            doc(
                db,
                "liveClasses",
                currentRoomId,
                "participants",
                currentUserId
            );


        await deleteDoc(
            participantRef
        );

    } catch (error) {

        console.warn(
            "Participant cleanup failed:",
            error
        );
    }


    // Stop listeners
    if (unsubscribeSignals) {

        unsubscribeSignals();

        unsubscribeSignals = null;
    }


    if (unsubscribeParticipants) {

        unsubscribeParticipants();

        unsubscribeParticipants = null;
    }


    processedSignals.clear();


    joined = false;

    currentRoomId = null;
    currentUserId = null;

    isTeacher = false;

    remoteContainer = null;
    localVideoElement = null;

    screenStream = null;
    isScreenSharing = false;


    console.log(
        "Left live classroom."
    );
}


// ============================================================
// FORCE CLOSE CONNECTION WITH A USER
// ============================================================

export function removeParticipant(
    userId
) {

    const pc =
        peerConnections.get(
            userId
        );


    if (pc) {

        try {
            pc.close();
        } catch {}

    }


    peerConnections.delete(
        userId
    );


    removeRemoteVideo(
        userId
    );
}


// ============================================================
// GET CONNECTION COUNT
// ============================================================

export function getConnectionCount() {

    return peerConnections.size;
}


// ============================================================
// EXPORT STATE
// ============================================================

export function getWebRTCState() {

    return {

        joined,

        roomId:
            currentRoomId,

        userId:
            currentUserId,

        isTeacher,

        cameraFacingMode,

        isScreenSharing,

        muted:
            isMuted(),

        cameraOff:
            isCameraOff(),

        connectionCount:
            peerConnections.size
    };
}
