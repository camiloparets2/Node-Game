import { reddit } from '@devvit/web/server';
import { getTodayDateStr, getTomorrowDateStr } from '../../shared/puzzle';

export const createPost = async (customTitle?: string) =>
  reddit.submitCustomPost({
    title: customTitle ?? `Schema Crisis — Daily Node-Link Puzzle · ${getTodayDateStr()}`,
  });

export const createTomorrowPost = async () =>
  reddit.submitCustomPost({
    title: `Schema Crisis — Daily Node-Link Puzzle · ${getTomorrowDateStr()}`,
  });
