// webrtc.js

import {
    auth,
    db,
    collection,
    doc,
    setDoc,
    deleteDoc,
    onSnapshot,
    serverTimestamp
} from "./firebase.js";

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

let localStream = null;
let cameraStream = null;
let screenStream = null;

let localVideoElement = null;
let remoteContainer = null;

let currentRoomId = null;
let currentUserId = null;

let isTeacher = false;
let joined = false;

let cameraFacingMode = "user";

let cameraTrack = null;
let audioTrack = null;

let isScreenSharing = false;

const peerConnections = new Map();
const remoteVideos = new Map();
const processedSignals = new Set();

let unsubscribeSignals = null;
let unsubscribeParticipants = null;
let unsubscribeBlock = null;


/* =========================================================
   CAMERA
========================================================= */

export async function startCamera(videoElement) {

    if (!auth.currentUser) {
        throw new Error("User is not logged in");
    }

    localVideoElement = videoElement || localVideoElement;

    if (cameraStream) {
        if (localVideoElement) {
            localVideoElement.srcObject = cameraStream;
            localVideoElement.muted = true;
            localVideoElement.playsInline = true;

            try {
                await localVideoElement.play();
            } catch (e) {}
        }

        return cameraStream;
    }

    cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: cameraFacingMode,
            width: {
                ideal: 1280
            },
            height: {
                ideal: 720
            }
        },
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        }
    });

    cameraTrack = cameraStream.getVideoTracks()[0];
    audioTrack = cameraStream.getAudioTracks()[0];

    localStream = cameraStream;

    if (localVideoElement) {

        localVideoElement.srcObject = cameraStream;
        localVideoElement.muted = true;
        localVideoElement.playsInline = true;

        try {
            await localVideoElement.play();
        } catch (e) {}
    }

    return cameraStream;
}


/* =========================================================
   STOP CAMERA
========================================================= */

export function stopCamera() {

    if (!cameraStream) return;

    cameraStream.getTracks().forEach(track => {
        track.stop();
    });

    cameraStream = null;
    localStream = null;
    cameraTrack = null;
    audioTrack = null;

    if (localVideoElement) {
        localVideoElement.srcObject = null;
    }
}


/* =========================================================
   FRONT / BACK CAMERA
========================================================= */

export async function switchCamera() {

    if (!cameraStream) {
        throw new Error("Camera is not running");
    }

    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera API unavailable");
    }

    cameraFacingMode =
        cameraFacingMode === "user"
            ? "environment"
            : "user";

    const newStream =
        await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: cameraFacingMode,
                width: {
                    ideal: 1280
                },
                height: {
                    ideal: 720
                }
            },
            audio: false
        });

    const newVideoTrack =
        newStream.getVideoTracks()[0];

    const oldVideoTrack = cameraTrack;

    cameraTrack = newVideoTrack;

    if (cameraStream) {

        cameraStream.removeTrack(oldVideoTrack);
        cameraStream.addTrack(newVideoTrack);

        oldVideoTrack.stop();
    }

    localStream = cameraStream;

    if (localVideoElement) {
        localVideoElement.srcObject = cameraStream;

        try {
            await localVideoElement.play();
        } catch (e) {}
    }

    /* Replace video track in every peer connection */

    for (const pc of peerConnections.values()) {

        const sender =
            pc.getSenders().find(
                s =>
                    s.track &&
                    s.track.kind === "video"
            );

        if (sender) {
            try {
                await sender.replaceTrack(newVideoTrack);
            } catch (error) {
                console.error(
                    "Camera replace failed:",
                    error
                );
            }
        }
    }

    await updateParticipantStatus({
        camera: true
    });

    return cameraFacingMode;
}


/* =========================================================
   MUTE
========================================================= */

export async function toggleMute() {

    if (!audioTrack) {
        return false;
    }

    audioTrack.enabled =
        !audioTrack.enabled;

    await updateParticipantStatus({
        mic: audioTrack.enabled
    });

    return audioTrack.enabled;
}


/* =========================================================
   CAMERA ON / OFF
========================================================= */

export async function toggleCamera() {

    if (!cameraTrack) {
        return false;
    }

    cameraTrack.enabled =
        !cameraTrack.enabled;

    await updateParticipantStatus({
        camera: cameraTrack.enabled
    });

    return cameraTrack.enabled;
}


/* =========================================================
   SCREEN SHARE
========================================================= */

export async function startScreenShare() {

    if (!isTeacher) {
        throw new Error(
            "Only teacher can share screen"
        );
    }

    if (isScreenSharing) {
        return;
    }

    screenStream =
        await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: "always"
            },
            audio: false
        });

    const screenTrack =
        screenStream.getVideoTracks()[0];

    for (const pc of peerConnections.values()) {

        const sender =
            pc.getSenders().find(
                s =>
                    s.track &&
                    s.track.kind === "video"
            );

        if (sender) {
            await sender.replaceTrack(screenTrack);
        }
    }

    isScreenSharing = true;

    screenTrack.onended = async () => {

        if (isScreenSharing) {
            await stopScreenShare();
        }
    };
}


export async function stopScreenShare() {

    if (!isScreenSharing) {
        return;
    }

    if (cameraTrack) {

        for (const pc of peerConnections.values()) {

            const sender =
                pc.getSenders().find(
                    s =>
                        s.track &&
                        s.track.kind === "video"
                );

            if (sender) {
                try {
                    await sender.replaceTrack(
                        cameraTrack
                    );
                } catch (error) {
                    console.error(error);
                }
            }
        }
    }

    if (screenStream) {

        screenStream
            .getTracks()
            .forEach(track => track.stop());

        screenStream = null;
    }

    isScreenSharing = false;
}


/* =========================================================
   CREATE PEER CONNECTION
========================================================= */

function createPeerConnection(remoteUserId) {

    if (peerConnections.has(remoteUserId)) {
        return peerConnections.get(remoteUserId);
    }

    const pc =
        new RTCPeerConnection(
            RTC_CONFIG
        );

    peerConnections.set(
        remoteUserId,
        pc
    );

    /* Teacher sends camera/mic */

    if (isTeacher && cameraStream) {

        cameraStream
            .getTracks()
            .forEach(track => {

                pc.addTrack(
                    track,
                    cameraStream
                );

            });
    }


    /* Remote video */

    pc.ontrack = event => {

        const stream =
            event.streams[0];

        if (!stream) return;

        createRemoteVideo(
            remoteUserId,
            stream
        );
    };


    /* ICE */

    pc.onicecandidate = async event => {

        if (!event.candidate) return;

        await sendSignal({
            type: "candidate",
            to: remoteUserId,
            candidate:
                event.candidate.toJSON()
        });
    };


    pc.onconnectionstatechange = () => {

        const state =
            pc.connectionState;

        console.log(
            "Connection:",
            remoteUserId,
            state
        );

        if (
            state === "failed" ||
            state === "closed"
        ) {
            removePeer(remoteUserId);
        }
    };


    pc.oniceconnectionstatechange = () => {

        if (
            pc.iceConnectionState ===
                "failed"
        ) {
            pc.restartIce();
        }
    };


    return pc;
}


/* =========================================================
   REMOTE VIDEO
========================================================= */

function createRemoteVideo(
    userId,
    stream
) {

    if (!remoteContainer) {
        return;
    }

    let wrapper =
        document.getElementById(
            `remote-${userId}`
        );

    if (!wrapper) {

        wrapper =
            document.createElement("div");

        wrapper.id =
            `remote-${userId}`;

        wrapper.className =
            "remote-video-wrapper";

        const video =
            document.createElement("video");

        video.autoplay = true;
        video.playsInline = true;
        video.controls = false;

        video.className =
            "remote-video";

        const label =
            document.createElement("div");

        label.className =
            "remote-user-label";

        label.textContent =
            "Student";

        wrapper.appendChild(video);
        wrapper.appendChild(label);

        remoteContainer.appendChild(
            wrapper
        );

        remoteVideos.set(
            userId,
            video
        );
    }

    const video =
        remoteVideos.get(userId);

    if (video) {
        video.srcObject = stream;

        video.play().catch(() => {});
    }
}


/* =========================================================
   REMOVE PEER
========================================================= */

function removePeer(userId) {

    const pc =
        peerConnections.get(userId);

    if (pc) {

        try {
            pc.close();
        } catch (e) {}

        peerConnections.delete(userId);
    }

    const video =
        remoteVideos.get(userId);

    if (video) {

        try {
            video.srcObject = null;
        } catch (e) {}

        remoteVideos.delete(userId);
    }

    const wrapper =
        document.getElementById(
            `remote-${userId}`
        );

    if (wrapper) {
        wrapper.remove();
    }
}


/* =========================================================
   SIGNAL
========================================================= */

async function sendSignal(data) {

    if (!currentRoomId) return;
    if (!currentUserId) return;

    await setDoc(
        doc(
            db,
            "liveClasses",
            currentRoomId,
            "signals",
            crypto.randomUUID()
        ),
        {
            ...data,

            from: currentUserId,

            createdAt:
                serverTimestamp()
        }
    );
}


/* =========================================================
   CREATE OFFER
========================================================= */

async function createOfferForStudent(
    studentId
) {

    if (!isTeacher) return;

    const pc =
        createPeerConnection(
            studentId
        );

    const offer =
        await pc.createOffer();

    await pc.setLocalDescription(
        offer
    );

    await sendSignal({
        type: "offer",
        to: studentId,
        sdp: {
            type: offer.type,
            sdp: offer.sdp
        }
    });
}


/* =========================================================
   HANDLE OFFER
========================================================= */

async function handleOffer(
    signal
) {

    const pc =
        createPeerConnection(
            signal.from
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
        to: signal.from,
        sdp: {
            type: answer.type,
            sdp: answer.sdp
        }
    });
}


/* =========================================================
   HANDLE ANSWER
========================================================= */

async function handleAnswer(
    signal
) {

    const pc =
        peerConnections.get(
            signal.from
        );

    if (!pc) return;

    await pc.setRemoteDescription(
        new RTCSessionDescription(
            signal.sdp
        )
    );
}


/* =========================================================
   HANDLE ICE
========================================================= */

async function handleCandidate(
    signal
) {

    const pc =
        peerConnections.get(
            signal.from
        );

    if (!pc) return;

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


/* =========================================================
   SIGNAL LISTENER
========================================================= */

function listenForSignals() {

    if (unsubscribeSignals) {
        unsubscribeSignals();
    }

    const signalsRef =
        collection(
            db,
            "liveClasses",
            currentRoomId,
            "signals"
        );

    unsubscribeSignals =
        onSnapshot(
            signalsRef,
            async snapshot => {

                for (
                    const change
                    of snapshot.docChanges()
                ) {

                    if (
                        change.type !==
                        "added"
                    ) {
                        continue;
                    }

                    const signal =
                        change.doc.data();

                    const signalId =
                        change.doc.id;

                    if (
                        processedSignals.has(
                            signalId
                        )
                    ) {
                        continue;
                    }

                    processedSignals.add(
                        signalId
                    );

                    if (
                        signal.to !==
                        currentUserId
                    ) {
                        continue;
                    }

                    if (
                        signal.from ===
                        currentUserId
                    ) {
                        continue;
                    }

                    try {

                        if (
                            signal.type ===
                            "offer"
                        ) {

                            await handleOffer(
                                signal
                            );

                        }

                        else if (
                            signal.type ===
                            "answer"
                        ) {

                            await handleAnswer(
                                signal
                            );

                        }

                        else if (
                            signal.type ===
                            "candidate"
                        ) {

                            await handleCandidate(
                                signal
                            );
                        }

                    } catch (error) {

                        console.error(
                            "Signal error:",
                            error
                        );
                    }
                }
            }
        );
}


/* =========================================================
   PARTICIPANT REGISTER
========================================================= */

async function registerParticipant() {

    if (!currentRoomId) return;
    if (!currentUserId) return;

    const user =
        auth.currentUser;

    await setDoc(
        doc(
            db,
            "liveClasses",
            currentRoomId,
            "participants",
            currentUserId
        ),
        {
            uid: currentUserId,

            name:
                user.displayName ||
                "Student",

            photoURL:
                user.photoURL || "",

            role:
                isTeacher
                    ? "teacher"
                    : "student",

            mic:
                isTeacher
                    ? true
                    : false,

            camera:
                isTeacher
                    ? true
                    : false,

            joinedAt:
                serverTimestamp()
        }
    );
}


/* =========================================================
   PARTICIPANT STATUS
========================================================= */

export async function updateParticipantStatus(
    data
) {

    if (
        !currentRoomId ||
        !currentUserId
    ) {
        return;
    }

    await setDoc(
        doc(
            db,
            "liveClasses",
            currentRoomId,
            "participants",
            currentUserId
        ),
        data,
        {
            merge: true
        }
    );
}


/* =========================================================
   TEACHER WATCH PARTICIPANTS
========================================================= */

function watchParticipants() {

    if (!isTeacher) return;

    if (unsubscribeParticipants) {
        unsubscribeParticipants();
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
            async snapshot => {

                for (
                    const change
                    of snapshot.docChanges()
                ) {

                    const studentId =
                        change.doc.id;

                    if (
                        studentId ===
                        currentUserId
                    ) {
                        continue;
                    }

                    if (
                        change.type ===
                        "added"
                    ) {

                        try {

                            await createOfferForStudent(
                                studentId
                            );

                        } catch (error) {

                            console.error(
                                "Offer failed:",
                                error
                            );
                        }
                    }

                    if (
                        change.type ===
                        "removed"
                    ) {

                        removePeer(
                            studentId
                        );
                    }
                }
            }
        );
}


/* =========================================================
   BLOCK LISTENER
   Student listens to permanent admin block
========================================================= */

function listenForBlock() {

    if (isTeacher) return;

    if (!currentRoomId) return;
    if (!currentUserId) return;

    const blockRef =
        doc(
            db,
            "liveClasses",
            currentRoomId,
            "blockedUsers",
            currentUserId
        );

    unsubscribeBlock =
        onSnapshot(
            blockRef,
            snapshot => {

                if (snapshot.exists()) {

                    console.warn(
                        "You have been blocked"
                    );

                    window.dispatchEvent(
                        new CustomEvent(
                            "liveUserBlocked",
                            {
                                detail:
                                    snapshot.data()
                            }
                        )
                    );

                    leaveRoom();
                }
            }
        );
}


/* =========================================================
   JOIN ROOM
========================================================= */

export async function joinRoom(
    roomId,
    teacher = false,
    container = null,
    videoElement = null
) {

    if (!auth.currentUser) {
        throw new Error(
            "Please login first"
        );
    }

    currentRoomId = roomId;
    currentUserId =
        auth.currentUser.uid;

    isTeacher = teacher;

    remoteContainer =
        container || null;

    localVideoElement =
        videoElement || null;


    /*
       IMPORTANT:

       Teacher:
       camera + mic ON

       Student:
       NO camera
       NO microphone
    */

    if (isTeacher) {

        await startCamera(
            localVideoElement
        );
    }


    /*
       Register participant.
       Firestore rules will reject
       blocked students.
    */

    await registerParticipant();


    listenForSignals();


    if (isTeacher) {
        watchParticipants();
    } else {
        listenForBlock();
    }


    joined = true;

    return {
        roomId: currentRoomId,
        userId: currentUserId,
        teacher: isTeacher
    };
}


/* =========================================================
   LEAVE ROOM
========================================================= */

export async function leaveRoom() {

    if (
        currentRoomId &&
        currentUserId
    ) {

        try {

            await deleteDoc(
                doc(
                    db,
                    "liveClasses",
                    currentRoomId,
                    "participants",
                    currentUserId
                )
            );

        } catch (error) {

            console.warn(
                "Participant cleanup failed:",
                error
            );
        }
    }


    if (unsubscribeSignals) {
        unsubscribeSignals();
        unsubscribeSignals = null;
    }

    if (unsubscribeParticipants) {
        unsubscribeParticipants();
        unsubscribeParticipants = null;
    }

    if (unsubscribeBlock) {
        unsubscribeBlock();
        unsubscribeBlock = null;
    }


    for (
        const userId
        of peerConnections.keys()
    ) {

        removePeer(userId);
    }


    peerConnections.clear();
    remoteVideos.clear();
    processedSignals.clear();


    if (screenStream) {

        screenStream
            .getTracks()
            .forEach(track => track.stop());

        screenStream = null;
    }

    isScreenSharing = false;


    if (cameraStream) {

        cameraStream
            .getTracks()
            .forEach(track => track.stop());

        cameraStream = null;
    }


    localStream = null;
    cameraTrack = null;
    audioTrack = null;


    if (localVideoElement) {
        localVideoElement.srcObject = null;
    }


    currentRoomId = null;
    currentUserId = null;

    isTeacher = false;
    joined = false;
}


/* =========================================================
   ADMIN REMOVE PARTICIPANT
========================================================= */

export async function removeParticipant(
    userId
) {

    if (!currentRoomId) {
        throw new Error(
            "No active room"
        );
    }

    if (!isTeacher) {
        throw new Error(
            "Only teacher can remove participants"
        );
    }

    removePeer(userId);

    await deleteDoc(
        doc(
            db,
            "liveClasses",
            currentRoomId,
            "participants",
            userId
        )
    );
}


/* =========================================================
   GETTERS
========================================================= */

export function getLocalStream() {
    return localStream;
}

export function getCameraStream() {
    return cameraStream;
}

export function getScreenStream() {
    return screenStream;
}

export function getScreenShareState() {
    return isScreenSharing;
}

export function isMuted() {

    return audioTrack
        ? !audioTrack.enabled
        : false;
}

export function isCameraOff() {

    return cameraTrack
        ? !cameraTrack.enabled
        : true;
}

export function getConnectionCount() {
    return peerConnections.size;
}

export function getWebRTCState() {

    return {
        joined,
        roomId: currentRoomId,
        userId: currentUserId,
        isTeacher,
        cameraFacingMode,
        isScreenSharing,
        connections:
            peerConnections.size
    };
}
