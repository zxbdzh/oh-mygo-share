export type ShareTemplate = 'minimal' | 'cinema' | 'vinyl' | 'polaroid' | 'ticket';

export type ShareLyricWord = {
	text: string;
	startMs: number;
	endMs: number;
};

export type ShareHotComment = {
	text: string;
	author: string;
	likes: number;
};

export type ShareLyric = {
	text: string;
	translation?: string;
	atMs: number;
	endMs: number;
	selected?: boolean;
	words?: ShareLyricWord[];
	stageEndMs?: number;
};

export type ShareMetadata = {
	token: string;
	title: string;
	artists: string;
	template: ShareTemplate;
	cardSquare: boolean;
	mode: 'full' | 'clip';
	durationMs: number;
	lyrics: ShareLyric[];
	hotComments?: ShareHotComment[];
	coverUrl?: string;
	sourceUrl?: string;
	audioUrl?: string;
	expiresAt: string;
	available: boolean;
};

export type Session = {
	sessionId: string;
	audioUrl: string;
};

export type Activity = {
	playing: boolean;
};
