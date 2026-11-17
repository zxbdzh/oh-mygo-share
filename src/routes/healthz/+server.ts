import { getShareApi } from '../../lib/server/runtime';

export const GET = ({ request }: { request: Request }) => getShareApi().fetch(request);
