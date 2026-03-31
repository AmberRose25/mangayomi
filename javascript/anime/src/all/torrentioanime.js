const mangayomiSources = [{
    "name": "Torrentio Anime (Debrid)",
    "lang": "all",
    "baseUrl": "https://torrentio.strem.fun",
    "apiUrl": "",
    "iconUrl": "https://raw.githubusercontent.com/m2k3a/mangayomi-extensions/main/javascript/icon/all.torrentio.png",
    "typeSource": "torrent",
    "isManga": false,
    "itemType": 1,
    "version": "0.0.3",
    "pkgPath": "anime/src/all/torrentioanime.js"
}];

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
    }

    anilistQuery() {
        return `
            query ($page: Int, $perPage: Int, $sort: [MediaSort], $search: String) {
                Page(page: $page, perPage: $perPage) {
                    pageInfo {
                        currentPage
                        hasNextPage
                    }
                    media(type: ANIME, sort: $sort, search: $search, status_in: [RELEASING, FINISHED, NOT_YET_RELEASED]) {
                        id
                        title { romaji english native }
                        coverImage { extraLarge large }
                        description
                        status
                        tags { name }
                        genres
                        studios { nodes { name } }
                        countryOfOrigin
                        isAdult
                    }
                }
            }
        `.trim();
    }

    anilistLatestQuery() {
        const currentTimeInSeconds = Math.floor(Date.now() / 1000);
        return `
            query ($page: Int, $perPage: Int, $sort: [AiringSort]) {
              Page(page: $page, perPage: $perPage) {
                pageInfo { currentPage hasNextPage }
                airingSchedules(airingAt_greater: 0 airingAt_lesser: ${currentTimeInSeconds - 10000} sort: $sort) {
                  media {
                    id
                    title { romaji english native }
                    coverImage { extraLarge large }
                    description
                    status
                    tags { name }
                    genres
                    studios { nodes { name } }
                    countryOfOrigin
                    isAdult
                  }
                }
              }
            }
        `.trim();
    }

    async makeGraphQLRequest(query, variables) {
        return await this.client.post("https://graphql.anilist.co", {}, { query, variables });
    }

    parseSearchJson(jsonLine, isLatestQuery = false) {
        const jsonData = JSON.parse(jsonLine);
        const mediaList = isLatestQuery 
            ? (jsonData.data?.Page?.airingSchedules.map(s => s.media) || [])
            : (jsonData.data?.Page?.media || []);
        const hasNextPage = jsonData.data?.Page?.pageInfo?.hasNextPage || false;

        const animeList = mediaList
            .filter(media => !((media?.countryOfOrigin === "CN" || media?.isAdult) && isLatestQuery))
            .map(media => {
                const preferenceTitle = new SharedPreferences().get("pref_title");
                let name = media?.title?.romaji || "";
                if (preferenceTitle === "english") name = media?.title?.english || media?.title?.romaji;
                else if (preferenceTitle === "native") name = media?.title?.native || "";

                return {
                    link: media?.id?.toString() || "",
                    name: name,
                    imageUrl: media?.coverImage?.extraLarge || ""
                };
            });

        return { "list": animeList, "hasNextPage": hasNextPage };
    }

    async getPopular(page) {
        const res = await this.makeGraphQLRequest(this.anilistQuery(), JSON.stringify({ page, perPage: 30, sort: "TRENDING_DESC" }));
        return this.parseSearchJson(res.body);
    }

    async getLatestUpdates(page) {
        const res = await this.makeGraphQLRequest(this.anilistLatestQuery(), JSON.stringify({ page, perPage: 30, sort: "TIME_DESC" }));
        return this.parseSearchJson(res.body, true);
    }

    async search(query, page, filters) {
        const res = await this.makeGraphQLRequest(this.anilistQuery(), JSON.stringify({ page, perPage: 30, sort: "POPULARITY_DESC", search: query }));
        return this.parseSearchJson(res.body);
    }

    async getDetail(url) {
        const query = `query($id: Int){ Media(id: $id){ id title { romaji english native } coverImage { extraLarge } description status tags { name } genres studios { nodes { name } } countryOfOrigin isAdult } }`;
        const res = await this.makeGraphQLRequest(query, JSON.stringify({ id: url }));
        const media = JSON.parse(res.body).data.Media;
        
        const anime = {
            imageUrl: media?.coverImage?.extraLarge || "",
            description: (media?.description || "No Description").replace(/<[^>]*>?/gm, ''),
            status: { "RELEASING": 0, "FINISHED": 1, "HIATUS": 2, "NOT_YET_RELEASED": 3 }[media?.status] || 5,
            genre: [...new Set([...(media?.tags?.map(t => t.name) || []), ...(media?.genres || [])])].sort(),
            author: media?.studios?.nodes?.map(n => n.name).join(", ")
        };

        const aniZip = await this.client.get(`https://api.ani.zip/mappings?anilist_id=${url}`);
        const kitsuId = JSON.parse(aniZip.body).mappings.kitsu_id;
        const kitsuReq = await this.client.get(`https://anime-kitsu.strem.fun/meta/series/kitsu%3A${kitsuId}.json`);
        const meta = JSON.parse(kitsuReq.body).meta;

        anime.episodes = (meta?.type === "movie") 
            ? [{ url: `/stream/movie/kitsu:${kitsuId}.json`, name: "Movie" }]
            : (meta?.videos || [])
                .filter(v => (v.released ? new Date(v.released) : Date.now()) < Date.now())
                .map(v => ({
                    url: `/stream/series/${v.id}.json`,
                    dateUpload: v.released ? new Date(v.released).getTime().toString() : null,
                    name: `Episode ${v.episode}${v.title ? " : " + v.title : ""}`
                })).reverse();

        return anime;
    }

    async getVideoList(url) {
        const pref = new SharedPreferences();
        const debridProvider = pref.get("debrid_provider");
        const debridKey = pref.get("debrid_key");

        let config = [];
        
        // Add basic filters
        const providers = pref.get("provider_selection");
        if (providers && providers.length > 0) config.push("providers=" + providers.join(","));
        
        const sort = pref.get("sorting_link");
        if (sort) config.push("sort=" + sort);
        
        const qualities = pref.get("quality_selection");
        if (qualities && qualities.length > 0) config.push("qualityfilter=" + qualities.join(","));

        // Add Debrid configuration if key exists
        if (debridKey && debridProvider !== "none") {
            config.push(`${debridProvider}=${debridKey}`);
        }

        const configPath = config.length > 0 ? config.join("|") : "";
        const finalUrl = `${this.source.baseUrl}/${configPath}${url}`;

        const response = await this.client.get(finalUrl);
        const streams = JSON.parse(response.body).streams || [];

        const trackers = [
            "http://nyaa.tracker.wf:7777/announce",
            "udp://tracker.opentrackr.org:1337/announce",
            "udp://open.stealth.si:80/announce",
            "udp://exodus.desync.com:6969/announce"
        ];

        const videos = streams.map(s => {
            let videoUrl = "";
            let labelSuffix = "";

            if (s.url) {
                // Debrid or Direct Link
                videoUrl = s.url;
                labelSuffix = " ⚡ [Debrid]";
            } else {
                // Peer-to-Peer Magnet
                videoUrl = `magnet:?xt=urn:btih:${s.infoHash}&dn=${s.infoHash}&tr=${trackers.join("&tr=")}${s.fileIdx ? "&index=" + s.fileIdx : ""}`;
                labelSuffix = " ⏳ [P2P]";
            }

            const title = `${(s.name || "").replace("Torrentio\n", "").trim()}\n${s.title || ""}`.trim() + labelSuffix;

            return {
                url: videoUrl,
                originalUrl: videoUrl,
                quality: title,
            };
        });

        const sorted = this.sortVideos(videos);
        const limit = pref.get("number_of_links");
        return limit === "all" ? sorted : sorted.slice(0, parseInt(limit));
    }

    sortVideos(videos) {
        const pref = new SharedPreferences();
        const isDub = pref.get("dubbed");
        const isEfficient = pref.get("efficient");

        return videos.sort((a, b) => {
            const isDubA = isDub && !a.quality.toLowerCase().includes("dubbed");
            const isDubB = isDub && !b.quality.toLowerCase().includes("dubbed");
            const isEffA = isEfficient && !["hevc", "265", "av1"].some(q => a.quality.toLowerCase().includes(q));
            const isEffB = isEfficient && !["hevc", "265", "av1"].some(q => b.quality.toLowerCase().includes(q));
            
            return (isDubA - isDubB) || (isEffA - isEffB);
        });
    }

    getSourcePreferences() {
        return [
            {
                "key": "debrid_provider",
                "listPreference": {
                    "title": "Debrid Provider",
                    "summary": "Choose your debrid service",
                    "valueIndex": 0,
                    "entries": ["None", "Real-Debrid", "AllDebrid", "Premiumize", "Debrid-Link", "TorBox", "EasyDebrid"],
                    "entryValues": ["none", "realdebrid", "alldebrid", "premiumize", "debridlink", "torbox", "easydebrid"],
                }
            },
            {
                "key": "debrid_key",
                "editTextPreference": {
                    "title": "Debrid API Key",
                    "summary": "Paste your Debrid API Key/Token here",
                    "value": ""
                }
            },
            {
                "key": "number_of_links",
                "listPreference": {
                    "title": "Number of links to load",
                    "summary": "Fewer links = faster loading",
                    "valueIndex": 2,
                    "entries": ["2", "4", "8", "12", "all"],
                    "entryValues": ["2", "4", "8", "12", "all"],
                }
            },
            {
                "key": "provider_selection",
                "multiSelectListPreference": {
                    "title": "Providers",
                    "entries": ["NyaaSi", "AniDex", "TokyoTosho", "HorribleSubs", "1337x", "RARBG", "EZTV", "YTS"],
                    "entryValues": ["nyaasi", "anidex", "tokyotosho", "horriblesubs", "1337x", "rarbg", "eztv", "yts"],
                    "values": ["nyaasi", "anidex"]
                }
            },
            {
                "key": "quality_selection",
                "multiSelectListPreference": {
                    "title": "Exclude Qualities",
                    "entries": ["4k", "1080p", "720p", "480p", "Cam", "Screener"],
                    "entryValues": ["4k", "1080p", "720p", "480p", "cam", "scr"],
                    "values": ["cam", "scr"]
                }
            },
            {
                "key": "sorting_link",
                "listPreference": {
                    "title": "Sorting",
                    "valueIndex": 1,
                    "entries": ["Quality then Seeders", "Quality then Size", "Seeders", "Size"],
                    "entryValues": ["quality", "qualitysize", "seeders", "size"],
                }
            },
            {
                "key": "pref_title",
                "listPreference": {
                    "title": "Preferred Title",
                    "valueIndex": 0,
                    "entries": ["Romaji", "English", "Native"],
                    "entryValues": ["romaji", "english", "native"],
                }
            },
            {
                "key": "dubbed",
                "switchPreferenceCompat": {
                    "title": "Dubbed Video Priority",
                    "value": false
                }
            },
            {
                "key": "efficient",
                "switchPreferenceCompat": {
                    "title": "Efficient (x265/HEVC) Priority",
                    "value": false
                }
            }
        ];
    }
}