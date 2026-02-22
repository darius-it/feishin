import { useWavesurfer } from '@wavesurfer/react';
import formatDuration from 'format-duration';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { PlayerbarSeekSlider } from './playerbar-seek-slider';
import { CustomPlayerbarSlider } from './playerbar-slider';
import styles from './playerbar-waveform.module.css';

import { useSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    BarAlign,
    usePlayerbarSlider,
    usePlayerSong,
    usePlayerStatus,
    usePlayerTimestamp,
} from '/@/renderer/store';
import { useAppThemeColors, useColorScheme } from '/@/renderer/themes/use-app-theme';
import { Text } from '/@/shared/components/text/text';
import { PlayerStatus } from '/@/shared/types/types';

interface WaveformWorkerResult {
    duration: number;
    error?: string;
    peaks: Float32Array[];
}

/**
 * Fetches audio, decodes it on the main thread, then
 * hands the raw PCM channel data to a Web Worker for CPU-intensive peak extraction
 */
function useWaveformPeaks(url: string | undefined, samples = 1024) {
    const [result, setResult] = useState<null | { duration: number; peaks: Float32Array[] }>(null);
    const abortRef = useRef<AbortController | null>(null);
    const workerRef = useRef<null | Worker>(null);

    useEffect(() => {
        setResult(null);
        if (!url) return;

        const abortController = new AbortController();
        abortRef.current = abortController;

        const worker = new Worker(new URL('../workers/waveform-worker.ts', import.meta.url), {
            type: 'module',
        });
        workerRef.current = worker;

        worker.onmessage = (e: MessageEvent<WaveformWorkerResult>) => {
            if (e.data.error) {
                console.error('Waveform worker error:', e.data.error);
                return;
            }
            setResult({ duration: e.data.duration, peaks: e.data.peaks });
        };

        worker.onerror = (err) => {
            console.error('Waveform worker failed:', err);
        };

        (async () => {
            try {
                const response = await fetch(url, { signal: abortController.signal });
                const arrayBuffer = await response.arrayBuffer();
                if (abortController.signal.aborted) return;

                const audioCtx = new AudioContext();
                const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
                await audioCtx.close();
                if (abortController.signal.aborted) return;

                // Extract raw channel data and transfer to the worker for peak computation
                const channelData: Float32Array[] = [];
                const transferables: ArrayBuffer[] = [];

                for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
                    const data = new Float32Array(audioBuffer.getChannelData(ch));
                    channelData.push(data);
                    transferables.push(data.buffer);
                }

                worker.postMessage(
                    { channelData, duration: audioBuffer.duration, samples },
                    transferables,
                );
            } catch (err: unknown) {
                if (abortController.signal.aborted) return;
                const message = err instanceof Error ? err.message : String(err);
                console.error('Waveform extraction error:', message);
            }
        })();

        return () => {
            abortController.abort();
            abortRef.current = null;
            worker.terminate();
            workerRef.current = null;
        };
    }, [url, samples]);

    return result;
}

export const PlayerbarWaveform = () => {
    const currentSong = usePlayerSong();
    const playerbarSlider = usePlayerbarSlider();
    const currentTime = usePlayerTimestamp();
    const status = usePlayerStatus();
    const containerRef = useRef<HTMLDivElement>(null);
    const { mediaSeekToTimestamp } = usePlayer();
    const [isLoading, setIsLoading] = useState(true);
    const [shouldRenderWaveform, setShouldRenderWaveform] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [tooltipPosition, setTooltipPosition] = useState<null | { x: number; y: number }>(null);
    const [tooltipValue, setTooltipValue] = useState(0);
    const seekTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const lastSeekValueRef = useRef<null | number>(null);
    const containerPositionRef = useRef<DOMRect | null>(null);

    const songDuration = currentSong?.duration ? currentSong.duration / 1000 : 0;

    const streamUrl = useSongUrl(currentSong, true, {
        bitrate: 64,
        enabled: true,
        format: 'mp3',
    });

    // Pre-compute waveform peaks to prevent audio element creation by wavesurfer
    const waveformResult = useWaveformPeaks(shouldRenderWaveform ? streamUrl : undefined);

    const { color } = useAppThemeColors();
    const primaryColor = (color['--theme-colors-primary'] as string) || 'rgb(53, 116, 252)';

    const colorScheme = useColorScheme();

    const waveColor = useMemo(() => {
        return colorScheme === 'dark' ? 'rgba(96, 96, 96, 1)' : 'rgba(96, 96, 96, 1)';
    }, [colorScheme]);

    const cursorColor = useMemo(() => {
        return colorScheme === 'dark' ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.5)';
    }, [colorScheme]);

    useEffect(() => {
        setShouldRenderWaveform(false);
        setIsLoading(true);
    }, [currentSong?.id]);

    useEffect(() => {
        if (!currentSong || shouldRenderWaveform) return;

        if (currentTime > 0) {
            setShouldRenderWaveform(true);
            return;
        }

        if (status !== PlayerStatus.PLAYING) {
            return;
        }

        setShouldRenderWaveform(true);
    }, [currentSong, currentTime, shouldRenderWaveform, status]);

    const { wavesurfer } = useWavesurfer({
        barAlign:
            playerbarSlider?.barAlign === BarAlign.CENTER ? undefined : playerbarSlider?.barAlign,
        barGap: playerbarSlider?.barGap,
        barRadius: playerbarSlider?.barRadius,
        barWidth: playerbarSlider?.barWidth,
        container: containerRef,
        cursorColor,
        cursorWidth: 2,
        fillParent: true,
        height: 18,
        interact: false,
        normalize: false,
        progressColor: primaryColor,
        waveColor,
    });

    useEffect(() => {
        if (!wavesurfer || !waveformResult) return;

        const handleReady = () => setIsLoading(false);
        wavesurfer.on('ready', handleReady);
        wavesurfer.load('', waveformResult.peaks, waveformResult.duration); // Load pre-computed peaks

        return () => {
            wavesurfer.un('ready', handleReady);
        };
    }, [wavesurfer, waveformResult]);

    // Handle drag start on waveform
    useEffect(() => {
        if (isLoading || !wavesurfer || !songDuration || !containerRef.current) return;

        const container = containerRef.current;
        let isDraggingLocal = false;

        const handleMouseDown = (e: MouseEvent) => {
            if (!wavesurfer) return;
            const duration = wavesurfer.getDuration();
            if (duration <= 0) return;

            isDraggingLocal = true;
            setIsDragging(true);

            // Cancel any pending timeout
            if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
            }

            const rect = container.getBoundingClientRect();
            containerPositionRef.current = rect;
            const clickX = e.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, clickX / rect.width));
            const seekTime = ratio * duration;
            lastSeekValueRef.current = seekTime;
            setTooltipPosition({ x: rect.left + clickX, y: rect.top });
            setTooltipValue(seekTime);
            wavesurfer.seekTo(ratio);
        };

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDraggingLocal || !wavesurfer) return;

            const duration = wavesurfer.getDuration();
            if (duration <= 0) return;

            const rect = container.getBoundingClientRect();
            containerPositionRef.current = rect;
            const clickX = e.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, clickX / rect.width));
            const seekTime = ratio * duration;
            lastSeekValueRef.current = seekTime;
            setTooltipPosition({ x: rect.left + clickX, y: rect.top });
            setTooltipValue(seekTime);
            wavesurfer.seekTo(ratio);
        };

        const handleMouseUp = () => {
            if (!isDraggingLocal || !wavesurfer) return;

            isDraggingLocal = false;
            const duration = wavesurfer.getDuration();
            const seekTime = wavesurfer.getCurrentTime();

            setTooltipPosition(null);

            if (duration > 0 && seekTime >= 0) {
                mediaSeekToTimestamp(seekTime);
                lastSeekValueRef.current = seekTime;

                // Set a fallback timeout to clear dragging state
                seekTimeoutRef.current = setTimeout(() => {
                    setIsDragging(false);
                    lastSeekValueRef.current = null;
                    seekTimeoutRef.current = null;
                }, 1000);
            } else {
                setIsDragging(false);
            }
        };

        // Handle touch events for mobile
        const handleTouchStart = (e: TouchEvent) => {
            if (!wavesurfer) return;
            const duration = wavesurfer.getDuration();
            if (duration <= 0) return;

            isDraggingLocal = true;
            setIsDragging(true);

            if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
            }

            const touch = e.touches[0];
            const rect = container.getBoundingClientRect();
            containerPositionRef.current = rect;
            const clickX = touch.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, clickX / rect.width));
            const seekTime = ratio * duration;
            lastSeekValueRef.current = seekTime;
            setTooltipPosition({ x: rect.left + clickX, y: rect.top });
            setTooltipValue(seekTime);
            wavesurfer.seekTo(ratio);
        };

        const handleTouchMove = (e: TouchEvent) => {
            if (!isDraggingLocal || !wavesurfer) return;
            e.preventDefault();

            const duration = wavesurfer.getDuration();
            if (duration <= 0) return;

            const touch = e.touches[0];
            const rect = container.getBoundingClientRect();
            containerPositionRef.current = rect;
            const clickX = touch.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, clickX / rect.width));
            const seekTime = ratio * duration;
            lastSeekValueRef.current = seekTime;
            setTooltipPosition({ x: rect.left + clickX, y: rect.top });
            setTooltipValue(seekTime);
            wavesurfer.seekTo(ratio);
        };

        const handleTouchEnd = () => {
            if (!isDraggingLocal || !wavesurfer) return;

            isDraggingLocal = false;
            const duration = wavesurfer.getDuration();
            const seekTime = wavesurfer.getCurrentTime();

            setTooltipPosition(null);

            if (duration > 0 && seekTime >= 0) {
                mediaSeekToTimestamp(seekTime);
                lastSeekValueRef.current = seekTime;

                seekTimeoutRef.current = setTimeout(() => {
                    setIsDragging(false);
                    lastSeekValueRef.current = null;
                    seekTimeoutRef.current = null;
                }, 1000);
            } else {
                setIsDragging(false);
            }
        };

        container.addEventListener('mousedown', handleMouseDown);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        container.addEventListener('touchstart', handleTouchStart, { passive: false });
        container.addEventListener('touchmove', handleTouchMove, { passive: false });
        container.addEventListener('touchend', handleTouchEnd);

        return () => {
            container.removeEventListener('mousedown', handleMouseDown);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
            container.removeEventListener('touchstart', handleTouchStart);
            container.removeEventListener('touchmove', handleTouchMove);
            container.removeEventListener('touchend', handleTouchEnd);
            if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
            }
        };
    }, [wavesurfer, songDuration, mediaSeekToTimestamp, isLoading]);

    // Sync dragging state when currentTime catches up to seek value
    useEffect(() => {
        if (isDragging && lastSeekValueRef.current !== null) {
            const timeDiff = Math.abs(currentTime - lastSeekValueRef.current);
            if (timeDiff < 0.5) {
                setIsDragging(false);
                setTooltipPosition(null);
                lastSeekValueRef.current = null;
                if (seekTimeoutRef.current) {
                    clearTimeout(seekTimeoutRef.current);
                    seekTimeoutRef.current = null;
                }
            }
        }
    }, [currentTime, isDragging]);

    // Update waveform progress based on player current time (only when not dragging)
    useEffect(() => {
        if (isLoading || !wavesurfer || !songDuration || isDragging) return;

        const duration = wavesurfer.getDuration();
        if (duration > 0 && currentTime >= 0) {
            const ratio = currentTime / duration;
            wavesurfer.seekTo(ratio);
        }
    }, [wavesurfer, currentTime, songDuration, isDragging, isLoading]);

    // Show disabled slider when there's no current song
    if (!currentSong) {
        return (
            <CustomPlayerbarSlider
                disabled
                max={100}
                min={0}
                onClick={(e) => {
                    e?.stopPropagation();
                }}
                size={6}
                value={0}
                w="100%"
            />
        );
    }

    return (
        <div
            className={styles.wavesurferContainer}
            onClick={(e) => {
                e?.stopPropagation();
            }}
            style={{ position: 'relative' }}
        >
            <motion.div
                animate={{ opacity: !isLoading ? 1 : 0 }}
                className={styles.waveform}
                initial={{ opacity: 0 }}
                ref={containerRef}
                style={{
                    minHeight: 18,
                    pointerEvents: !isLoading ? 'auto' : 'none',
                }}
                transition={{ duration: 0.2 }}
            />
            {isLoading && (
                <motion.div
                    animate={{ opacity: 1 }}
                    initial={{ opacity: 0 }}
                    style={{
                        height: '100%',
                        left: 0,
                        position: 'absolute',
                        top: 3,
                        width: '100%',
                    }}
                    transition={{ duration: 0.2 }}
                >
                    <PlayerbarSeekSlider max={songDuration} min={0} />
                </motion.div>
            )}
            {tooltipPosition && isDragging && !isLoading && (
                <motion.div
                    animate={{ opacity: 1, scale: 1, x: '-50%' }}
                    className={styles.tooltip}
                    initial={{ opacity: 0, scale: 0.8, x: '-50%' }}
                    style={{
                        left: `${tooltipPosition.x}px`,
                        position: 'fixed',
                        top: `${tooltipPosition.y - 40}px`,
                        zIndex: 1000,
                    }}
                    transition={{ duration: 0.15 }}
                >
                    <Text isNoSelect size="md">
                        {formatDuration(tooltipValue * 1000)}
                    </Text>
                </motion.div>
            )}
        </div>
    );
};
