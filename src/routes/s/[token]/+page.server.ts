import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, fetch }) => {
    const res = await fetch(`/api/public/${params.token}`);
    if (!res.ok) {
        // 返回错误以便页面显示过期/不可用
        return { error: true, status: res.status };
    }
    const data = await res.json();
    return { share: data };
};
