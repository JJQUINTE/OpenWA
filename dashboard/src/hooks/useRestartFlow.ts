import { useEffect, useRef, useState } from 'react';
import { infraApi } from '../services/api';
import { restartPollAttempts } from '../utils/restartPoll';

export type RestartStatus = 'idle' | 'restarting' | 'waiting' | 'success' | 'error';

export interface RestartOpenRequest {
  profiles: string[];
  // The built-in profiles running now; the restart stops each one the new config no longer needs.
  running: string[];
  dbSwitch: boolean;
  storageSwitch: boolean;
}

export interface RestartFlow {
  showRestartModal: boolean;
  restartCountdown: number;
  restartStatus: RestartStatus;
  pendingProfiles: string[];
  runningProfiles: string[];
  dbSwitch: boolean;
  storageSwitch: boolean;
  open: (req: RestartOpenRequest) => void;
  close: () => void;
  start: () => void;
}

/**
 * Owns the post-save restart modal: the show/countdown/status state machine, the pending/running
 * profile pair that drives `infraApi.restart(...)`, and the db/storage-switch flags the modal's
 * data-loss warning reads (#488). `open()` is the single entry point a caller (the page's save
 * `onSaved`) uses to hand over a fresh save result.
 *
 * The running set is taken from the caller on every open, not carried over from an earlier save: the
 * page reloads after each restart, so an earlier save is usually not there, and when it is, it says
 * what that save wanted rather than what is running.
 */
export function useRestartFlow(): RestartFlow {
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [restartCountdown, setRestartCountdown] = useState(0);
  const [restartStatus, setRestartStatus] = useState<RestartStatus>('idle');
  const [profiles, setProfiles] = useState<{ pending: string[]; running: string[] }>({
    pending: [],
    running: [],
  });
  // Set when the just-saved config changes the DB or storage backend vs what's running, so the restart
  // modal can warn that the new backend starts empty and offer a data backup before switching (#488).
  const [dbSwitch, setDbSwitch] = useState(false);
  const [storageSwitch, setStorageSwitch] = useState(false);

  // Every pending health-poll timeout and the countdown interval are tracked so an unmount (navigating
  // away mid-restart) cancels them instead of letting them fire setState on a dead component. The
  // trailing window.location.reload() on success is kept — a restart that already completed is meant
  // to reload the page.
  const pollTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const pollTimeouts = pollTimeoutsRef.current;
    return () => {
      for (const handle of pollTimeouts) clearTimeout(handle);
      pollTimeouts.clear();
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, []);

  const schedulePollTimeout = (fn: () => void, ms: number) => {
    const handle = setTimeout(() => {
      pollTimeoutsRef.current.delete(handle);
      fn();
    }, ms);
    pollTimeoutsRef.current.add(handle);
  };

  const stopCountdown = () => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  };

  const open = ({
    profiles: pending,
    running,
    dbSwitch: nextDbSwitch,
    storageSwitch: nextStorageSwitch,
  }: RestartOpenRequest) => {
    setProfiles({ pending, running });
    setDbSwitch(nextDbSwitch);
    setStorageSwitch(nextStorageSwitch);
    setShowRestartModal(true);
  };

  // Dismissal is only offered in the idle state — while a restart is running there is deliberately
  // no way to close the progress view. Shared by the modal's onClose and the "Later" button; both
  // only ever fire while idle, since "Later" is rendered exclusively inside the idle branch.
  const close = () => {
    if (restartStatus === 'idle') setShowRestartModal(false);
  };

  const checkServerHealth = (estimatedTime?: number) => {
    let attempts = 0;
    const maxAttempts = restartPollAttempts(estimatedTime);

    const check = async () => {
      try {
        await infraApi.healthCheck();
        stopCountdown();
        setRestartCountdown(0);
        setRestartStatus('success');
        schedulePollTimeout(() => window.location.reload(), 2000);
      } catch {
        attempts++;
        if (attempts < maxAttempts) schedulePollTimeout(check, 1000);
        else setRestartStatus('error');
      }
    };

    schedulePollTimeout(check, 3000);
  };

  const start = async () => {
    setRestartStatus('restarting');
    setRestartCountdown(30);

    const profilesToRemove = profiles.running.filter(p => !profiles.pending.includes(p));

    // Kept outside the try: the poll deadline is derived from it, and the restart call is expected to
    // fail sometimes (the server may go down before it answers).
    let estimatedTime: number | undefined;
    try {
      const response = await infraApi.restart(profiles.pending, profilesToRemove);
      estimatedTime = response.estimatedTime;
      if (response.estimatedTime) setRestartCountdown(response.estimatedTime);
    } catch {
      // Expected — server shutting down
    }

    setRestartStatus('waiting');
    stopCountdown();
    countdownIntervalRef.current = setInterval(() => {
      setRestartCountdown(prev => {
        if (prev <= 1) {
          stopCountdown();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    checkServerHealth(estimatedTime);
  };

  return {
    showRestartModal,
    restartCountdown,
    restartStatus,
    pendingProfiles: profiles.pending,
    runningProfiles: profiles.running,
    dbSwitch,
    storageSwitch,
    open,
    close,
    start,
  };
}
