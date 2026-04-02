import { Hono } from 'hono';
import type { UiResponse } from '@devvit/web/shared';
import { context } from '@devvit/web/server';
import { createPost, createTomorrowPost } from '../core/post';

export const menu = new Hono();

menu.post('/post-create', async (c) => {
  try {
    const post = await createPost();
    return c.json<UiResponse>(
      { navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}` },
      200,
    );
  } catch {
    return c.json<UiResponse>({ showToast: 'Failed to create Schema Crisis post — try again.' }, 400);
  }
});

menu.post('/post-tomorrow', async (c) => {
  try {
    const post = await createTomorrowPost();
    return c.json<UiResponse>(
      { navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}` },
      200,
    );
  } catch {
    return c.json<UiResponse>({ showToast: "Failed to create tomorrow's Schema Crisis post — try again." }, 400);
  }
});
