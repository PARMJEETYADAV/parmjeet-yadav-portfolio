import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));
app.use(express.json());

const dataDir = path.join(__dirname, 'data');
const profilePath = path.join(dataDir, 'portfolio.json');
const linkedinPath = path.join(dataDir, 'linkedin.json');
const cachePath = path.join(dataDir, 'cache.json');

let state = {
    profile: {},
    skills: [],
    projects: [],
    certifications: [],
    experience: [],
    education: [],
    githubRepos: [],
    githubActivity: [],
    linkedinHighlights: [],
    linkedinActivity: [],
    githubStats: {},
    syncedAt: null,
    lastError: null,
};

let syncInFlight = false;

async function readJson(filePath, fallback = {}) {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function toTitleCase(text) {
    return text
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function normalizeLinkedInExperience(items = []) {
    if (!Array.isArray(items)) {
        return [];
    }

    return items.map((item) => {
        if (typeof item === 'string') {
            return {
                role: item,
                organization: 'LinkedIn',
                period: 'Now',
                summary: 'Imported from LinkedIn.',
                source: 'linkedin',
            };
        }

        return {
            role: item.role || item.title || item.position || item.jobTitle || item.designation || 'Professional Update',
            organization: item.organization || item.company || item.employer || 'LinkedIn',
            period: item.period || item.duration || item.date || 'Now',
            summary: item.summary || item.description || item.responsibilities || 'Imported from LinkedIn.',
            source: 'linkedin',
        };
    });
}

function normalizeLinkedInSkills(items = []) {
    if (!Array.isArray(items)) {
        return [];
    }

    return items.map((skill) => ({
        category: skill.category || 'LinkedIn Skills',
        items: Array.isArray(skill.items) ? skill.items : [skill.name || skill].filter(Boolean),
        source: 'linkedin',
    }));
}

async function loadLinkedInData() {
    return readJson(linkedinPath, { profile: {}, highlights: [], activity: [], experience: [], education: [], skills: [] });
}

async function loadBaseData() {
    const base = await readJson(profilePath, { profile: {}, projects: [], skills: [], certifications: [], experience: [], education: [] });
    const linkedin = await loadLinkedInData();
    const cache = await readJson(cachePath, {});

    state.profile = { ...base.profile, ...linkedin.profile };
    state.skills = [
        ...(base.skills || []),
        ...normalizeLinkedInSkills(linkedin.skills || []),
    ];
    state.projects = base.projects || [];
    state.certifications = base.certifications || [];
    state.experience = [
        ...(base.experience || []),
        ...normalizeLinkedInExperience(linkedin.experience || linkedin.experiences || linkedin.workExperience || linkedin.positions || []),
    ];
    state.education = [
        ...(base.education || []),
        ...((linkedin.education || []).map((item) => ({ ...item, source: 'linkedin' }))),
    ];
    state.githubRepos = base.githubRepos || [];
    state.githubActivity = cache.githubActivity || [];
    state.linkedinActivity = linkedin.activity || cache.linkedinActivity || [];
    state.linkedinHighlights = linkedin.highlights || [];
    state.githubStats = cache.githubStats || {};
    state.syncedAt = cache.syncedAt || null;
    state.lastError = cache.lastError || null;
}

async function syncGitHub() {
    const username = process.env.GITHUB_USERNAME || 'parmjeet-yadav';
    const token = process.env.GITHUB_TOKEN;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    try {
        const userRes = await fetch(`https://api.github.com/users/${username}`, { headers });
        if (!userRes.ok) throw new Error(`GitHub user lookup failed: ${userRes.status}`);
        const user = await userRes.json();

        const reposRes = await fetch(`https://api.github.com/users/${username}/repos?per_page=6&sort=updated`, { headers });
        if (!reposRes.ok) throw new Error(`GitHub repos lookup failed: ${reposRes.status}`);
        const repos = await reposRes.json();

        const githubRepos = repos.map((repo) => ({
            name: repo.name,
            description: repo.description || 'Repository updated recently.',
            homepage: repo.homepage || null,
            html_url: repo.html_url,
            language: repo.language || 'Mixed',
            stargazers_count: repo.stargazers_count || 0,
            forks_count: repo.forks_count || 0,
            updated_at: repo.updated_at,
        }));

        state.githubRepos = githubRepos;
        state.githubStats = {
            login: user.login,
            public_repos: user.public_repos || 0,
            followers: user.followers || 0,
            public_gists: user.public_gists || 0,
            html_url: user.html_url,
            avatar_url: user.avatar_url,
            last_updated: new Date().toISOString(),
        };
    } catch (error) {
        state.lastError = error.message;
    }
}

async function syncLinkedIn() {
    try {
        const linkedinUrl = process.env.LINKEDIN_DATA_URL;
        if (linkedinUrl) {
            const res = await fetch(linkedinUrl);
            if (!res.ok) throw new Error(`LinkedIn data fetch failed: ${res.status}`);
            const data = await res.json();
            state.linkedinHighlights = data.highlights || [];
            state.linkedinActivity = data.activity || [];
            const linkedinSkills = normalizeLinkedInSkills(data.skills || []);
            state.skills = [...state.skills.filter((item) => item.source !== 'linkedin'), ...linkedinSkills];
            state.experience = [
                ...normalizeLinkedInExperience(data.experience || data.experiences || data.workExperience || data.positions || []),
                ...(state.experience.filter((item) => item.source !== 'linkedin')),
            ].slice(0, 10);
            state.education = [
                ...(data.education || []).map((item) => ({ ...item, source: 'linkedin' })),
                ...(state.education.filter((item) => item.source !== 'linkedin')),
            ].slice(0, 10);
            return;
        }

        const linkedinData = await loadLinkedInData();
        state.linkedinHighlights = linkedinData.highlights || [];
        state.linkedinActivity = linkedinData.activity || [];
        const localLinkedInSkills = normalizeLinkedInSkills(linkedinData.skills || []);
        state.skills = [...state.skills.filter((item) => item.source !== 'linkedin'), ...localLinkedInSkills];
        state.experience = [
            ...normalizeLinkedInExperience(linkedinData.experience || linkedinData.experiences || linkedinData.workExperience || linkedinData.positions || []),
            ...(state.experience.filter((item) => item.source !== 'linkedin')),
        ].slice(0, 10);
        state.education = [
            ...(linkedinData.education || []).map((item) => ({ ...item, source: 'linkedin' })),
            ...(state.education.filter((item) => item.source !== 'linkedin')),
        ].slice(0, 10);
    } catch (error) {
        state.lastError = error.message;
    }
}

async function syncSources() {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
        await loadBaseData();
        await syncGitHub();
        await syncLinkedIn();
        state.syncedAt = new Date().toISOString();
        await fs.mkdir(dataDir, { recursive: true });
        await fs.writeFile(cachePath, JSON.stringify({
            syncedAt: state.syncedAt,
            githubActivity: state.githubActivity,
            linkedinActivity: state.linkedinActivity,
            githubStats: state.githubStats,
            lastError: state.lastError,
        }, null, 2));
    } finally {
        syncInFlight = false;
    }
}

app.get('/', async (req, res) => {
    await syncSources();
    res.render('index', {
        state,
        titleCase: toTitleCase,
    });
});

app.get('/api/refresh', async (req, res) => {
    await syncSources();
    res.json({ ok: true, syncedAt: state.syncedAt, repositories: state.githubRepos.length, highlights: state.linkedinHighlights.length });
});

app.get('/api/linkedin-status', async (req, res) => {
    await syncSources();
    const lastUpdated = state.linkedinActivity?.[0]?.at || state.syncedAt || new Date().toISOString();
    res.json({
        title: 'Professional profile active',
        text: `${state.linkedinHighlights.length} LinkedIn highlights and updates are ready to view. Last sync ${new Date(lastUpdated).toLocaleString()}.`,
        highlights: state.linkedinHighlights.length,
        lastUpdated,
    });
});

app.get('/api/linkedin-feed', async (req, res) => {
    await syncSources();
    res.json({
        profile: state.profile,
        highlights: state.linkedinHighlights,
        activity: state.linkedinActivity,
        skills: state.skills.filter((item) => item.source === 'linkedin' || item.category),
        experience: state.experience.filter((item) => item.source === 'linkedin' || item.role || item.organization),
        education: state.education.filter((item) => item.source === 'linkedin' || item.degree || item.institution),
    });
});

app.post('/api/linkedin-update', async (req, res) => {
    const payload = req.body || {};
    const linkedInData = await loadLinkedInData();
    const entry = {
        title: payload.title || 'LinkedIn update',
        summary: payload.summary || 'A new professional update was added to the portfolio.',
        at: new Date().toISOString(),
    };

    const incomingExperience = normalizeLinkedInExperience(
        payload.experience || payload.experiences || payload.workExperience || payload.positions || []
    );
    const experienceEntry = incomingExperience[0] || {
        role: payload.role || 'Professional update',
        organization: payload.organization || 'LinkedIn',
        period: payload.period || 'Now',
        summary: payload.summary || 'Added from the portfolio LinkedIn sync form.',
        source: 'linkedin',
    };

    const updated = {
        profile: { ...(linkedInData.profile || {}), ...(payload.profile || {}) },
        highlights: [entry, ...(linkedInData.highlights || [])].slice(0, 6),
        activity: [{ type: 'linkedin', title: entry.title, summary: entry.summary, at: entry.at }, ...(linkedInData.activity || [])].slice(0, 8),
        experience: [experienceEntry, ...normalizeLinkedInExperience(linkedInData.experience || linkedInData.experiences || linkedInData.workExperience || linkedInData.positions || []), ...incomingExperience.slice(1)].slice(0, 6),
        education: linkedInData.education || [],
        skills: [
            ...(linkedInData.skills || []),
            ...(payload.skills ? [{ category: 'LinkedIn Skills', items: payload.skills.split(',').map((item) => item.trim()).filter(Boolean), source: 'linkedin' }] : []),
        ].slice(0, 6),
    };

    await fs.writeFile(linkedinPath, JSON.stringify(updated, null, 2));
    state.profile = { ...state.profile, ...updated.profile };
    state.linkedinHighlights = updated.highlights;
    state.linkedinActivity = updated.activity;
    state.skills = [
        ...(state.skills.filter((item) => item.source !== 'linkedin')),
        ...((updated.skills || []).map((skill) => ({ ...skill, source: 'linkedin' }))),
    ];
    state.experience = [experienceEntry, ...state.experience.filter((item) => item.source !== 'linkedin')].slice(0, 8);
    state.syncedAt = new Date().toISOString();

    res.json({ ok: true, update: entry, experience: experienceEntry });
});

app.post('/api/webhooks/github', (req, res) => {
    const event = req.get('X-GitHub-Event') || 'ping';
    const payload = req.body || {};
    const entry = {
        type: 'github',
        event,
        actor: payload.sender?.login || 'unknown',
        repo: payload.repository?.full_name || 'unknown',
        action: payload.action || 'received',
        at: new Date().toISOString(),
    };
    state.githubActivity = [entry, ...state.githubActivity].slice(0, 6);
    state.syncedAt = new Date().toISOString();
    res.json({ ok: true, received: entry });
});

app.post('/api/webhooks/linkedin', async (req, res) => {
    const payload = req.body || {};
    const entry = {
        type: 'linkedin',
        title: payload.title || 'LinkedIn update',
        summary: payload.summary || 'A new professional update was received.',
        at: new Date().toISOString(),
    };

    const professionalEntry = {
        role: payload.role || 'Professional Update',
        organization: payload.organization || 'LinkedIn',
        period: payload.period || 'Now',
        summary: payload.summary || 'Updated from LinkedIn webhook.',
        source: 'linkedin',
    };

    const incomingSkills = Array.isArray(payload.skills)
        ? payload.skills
        : typeof payload.skills === 'string'
            ? payload.skills.split(',').map((item) => item.trim()).filter(Boolean)
            : [];

    state.linkedinActivity = [entry, ...state.linkedinActivity].slice(0, 6);
    state.linkedinHighlights = [
        { title: entry.title, summary: entry.summary },
        ...state.linkedinHighlights,
    ].slice(0, 6);
    state.skills = [...state.skills.filter((item) => item.source !== 'linkedin'), ...(incomingSkills.length ? [{ category: 'LinkedIn Skills', items: incomingSkills, source: 'linkedin' }] : [])];
    state.experience = [professionalEntry, ...state.experience.filter((item) => item.source !== 'linkedin')];
    state.syncedAt = new Date().toISOString();

    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(linkedinPath, JSON.stringify({
        profile: state.profile,
        highlights: state.linkedinHighlights,
        activity: state.linkedinActivity,
        experience: state.experience.filter((item) => item.source === 'linkedin'),
        education: [],
        skills: state.skills.filter((item) => item.source === 'linkedin'),
    }, null, 2));

    res.json({ ok: true, received: entry });
});

app.listen(port, () => {
    console.log(`Portfolio SSR server running at http://localhost:${port}`);
});

setInterval(() => {
    syncSources().catch((error) => {
        state.lastError = error.message;
    });
}, 1000 * 60 * 2);
