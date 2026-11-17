import type { RequestHandler } from './$types';
import { getShareApi } from '../../../lib/server/runtime';

const proxy: RequestHandler = ({ request }) => getShareApi().fetch(request);

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
