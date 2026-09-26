# CHANGELOG

<!-- version list -->

## v0.9.0 (2026-09-26)

### Bug Fixes

- The analysis server takes the port it is given (PORT), so two dev servers can run at once
  ([`c7ba836`](https://github.com/AnthusAI/Apricity/commit/c7ba836414bd9cd07b362edb4c73d6983b85e1d8))

- The Vite dev server runs against the library (sound, data, files); no localhost/127.0.0.1 split
  ([`964fafc`](https://github.com/AnthusAI/Apricity/commit/964fafc42cd32289df44aa9070ef09353d530727))

- **apricitus-003de8**: Clip names are unique on their sample
  ([`8557906`](https://github.com/AnthusAI/Apricity/commit/85579067b8024a4b734b95836582675ea61d2361))

- **apricitus-1a798f**: New scores and copies find their samples from the person's own folder
  ([`a85d588`](https://github.com/AnthusAI/Apricity/commit/a85d5889f0019d6b099db8feb1a4559fcd672138))

- **apricitus-3ae1f8**: Failures are shown, not swallowed
  ([`279a0ea`](https://github.com/AnthusAI/Apricity/commit/279a0ea3274099494fe3e8126a997d013a2534d3))

- **apricitus-5079d7**: A numeral before a multi-byte suffix (iiø) no longer panics the chord parser
  ([`405672e`](https://github.com/AnthusAI/Apricity/commit/405672ea97a5c8a4809c9974ee99c792579cc60b))

- **apricitus-5cb893**: Audio that fails loudly and recovers
  ([`7546361`](https://github.com/AnthusAI/Apricity/commit/75463618729212a80043b4ef91102e273a9cc25c))

- **apricitus-7b725e**: The Docs tab says Help; the landing page says Browse samples
  ([`426ba87`](https://github.com/AnthusAI/Apricity/commit/426ba87e28f415cbd1ab41178d455c068475d9a0))

- **apricitus-95b453**: Saving works in local mode
  ([`813c2b3`](https://github.com/AnthusAI/Apricity/commit/813c2b35ea6d049baee20fd3b8f7ecb8108ded6a))

- **apricitus-9adc03**: A kit's pads keep their recorded balance
  ([`f507f62`](https://github.com/AnthusAI/Apricity/commit/f507f62e9ef36af50b56bfbbe2fb76c7e6ab0dc1))

- **apricitus-9d5f92**: The top bar's sun mirrors the play button
  ([`1902ecd`](https://github.com/AnthusAI/Apricity/commit/1902ecdabba5e9cf2f1e9eea881468003309eb83))

- **apricitus-9eae1c**: Never await sign-in at the top of main.ts
  ([`a9e3793`](https://github.com/AnthusAI/Apricity/commit/a9e37938d86533ece5e69786f99348754af61019))

- **apricitus-b04632**: Markup re-runs keep the clips they made
  ([`ba51952`](https://github.com/AnthusAI/Apricity/commit/ba51952c27d3cd79b0f3ad4cb02fadae13b3c76c))

- **apricitus-b834fe**: Regenerate the web lock file with npm 10, which CI's npm ci accepts
  ([`eb3cfc7`](https://github.com/AnthusAI/Apricity/commit/eb3cfc7cbc79d911da6416577851f082a3f85a88))

- **apricitus-c8790a**: Hold pitch tags read at the clip's start, spelled with flats
  ([`5509c6a`](https://github.com/AnthusAI/Apricity/commit/5509c6acbaee281d697a71f645f97e0aab5e1e6c))

- **apricitus-ca8ee6**: CI builds the wasm as Amplify does, with this platform's wasi-sdk
  ([`03e72df`](https://github.com/AnthusAI/Apricity/commit/03e72df1c9d2f5fc911b7e79f7ae090bd980eef7))

- **apricitus-ca8ee6**: CI builds the wasm for the web tests; the sources specs count 9
  ([`f5d41c3`](https://github.com/AnthusAI/Apricity/commit/f5d41c3c872b06eee639c4441567bb5048cc576c))

- **apricitus-cb4b48**: Leaving a page stops its sound
  ([`7f553b6`](https://github.com/AnthusAI/Apricity/commit/7f553b6fe6cecc7a63c00b4da6b29d3527c98b03))

- **apricitus-d2a42b**: The New button sits beside search, leaving the bottom-left to the account;
  on the home page the account is top right
  ([`f20ec8d`](https://github.com/AnthusAI/Apricity/commit/f20ec8d0c5062da2f095da27b0ecde700e8bb212))

- **apricitus-eca772**: Star filters see ratings made since the list loaded
  ([`ac734a8`](https://github.com/AnthusAI/Apricity/commit/ac734a8da2a5728d0000dd27e660856b065d737c))

- **apricitus-f10f47**: Refresh the announcer's curation candidates
  ([#3](https://github.com/AnthusAI/Apricity/pull/3),
  [`7958c12`](https://github.com/AnthusAI/Apricity/commit/7958c12267afea7e3bf964b31622f77a3f2a8092))

- **apricitus-f10f47**: The voice-layer announcer no longer misdates the recording
  ([#3](https://github.com/AnthusAI/Apricity/pull/3),
  [`7958c12`](https://github.com/AnthusAI/Apricity/commit/7958c12267afea7e3bf964b31622f77a3f2a8092))

- **apricitus-ff7e75**: Panels give way before the editor does
  ([`9a0a6ba`](https://github.com/AnthusAI/Apricity/commit/9a0a6ba00aff5ae03afed2a3dc7801d407be9606))

- **web**: Breakdown sound starts on iOS; the sound button says why it is missing
  ([`f200e72`](https://github.com/AnthusAI/Apricity/commit/f200e72c79e986786ad071cae7b5dfc8ab3301ce))

### Chores

- **apricitus-22a025**: SessionStart hook installs the Kanbus CLI in web sessions
  ([`e30b933`](https://github.com/AnthusAI/Apricity/commit/e30b9330caf0189892041457f74ff0e83e984cc9))

- **kanbus**: Commit board state (issues)
  ([`ce088b7`](https://github.com/AnthusAI/Apricity/commit/ce088b75769258d0b4ef608d70c3cb32be5eeb51))

- **kanbus**: Commit board state (issues)
  ([`cc569a5`](https://github.com/AnthusAI/Apricity/commit/cc569a562edfd56e32cd6d2133a76265ebe467f8))

- **kanbus**: Commit board state (issues)
  ([`69858bb`](https://github.com/AnthusAI/Apricity/commit/69858bb0a9e514bd77b91705a4576fd856794392))

- **kanbus**: Commit board state (issues)
  ([`96addf3`](https://github.com/AnthusAI/Apricity/commit/96addf3e726209f12fb92c47ab7a797b27368663))

- **kanbus**: Commit board state (issues)
  ([`7bd8908`](https://github.com/AnthusAI/Apricity/commit/7bd89083ce90af205d41a9a0c409898c5230fde1))

- **kanbus**: Commit board state (issues)
  ([`4aa226c`](https://github.com/AnthusAI/Apricity/commit/4aa226c6f3e421e52acedbfc168be6e0f6b44e60))

- **kanbus**: Commit board state (issues)
  ([`cd1a1a8`](https://github.com/AnthusAI/Apricity/commit/cd1a1a8fb6e687efbb67072b88b4876cc5bad8b4))

- **kanbus**: Commit board state (issues)
  ([`8b54006`](https://github.com/AnthusAI/Apricity/commit/8b540069bc57f6635ba403373c6a3774b9fa6f87))

- **kanbus**: Commit board state (issues)
  ([`23e2457`](https://github.com/AnthusAI/Apricity/commit/23e24578e7936cbf663a9f6c8d8cad7deca71ab7))

- **kanbus**: Commit board state (issues)
  ([`ae69422`](https://github.com/AnthusAI/Apricity/commit/ae694229724f0543ba801370f655250b40a8e74f))

- **kanbus**: Commit board state (issues)
  ([`17b09f7`](https://github.com/AnthusAI/Apricity/commit/17b09f7989997a967063aae1ae60de28174659e5))

- **kanbus**: Commit board state (issues)
  ([`152d202`](https://github.com/AnthusAI/Apricity/commit/152d202f1f7be4770fc07ee0facc2558f2284156))

- **kanbus**: Commit board state (issues)
  ([`d7f3a64`](https://github.com/AnthusAI/Apricity/commit/d7f3a6491db2458b51a602daeba6efeadf861f34))

- **kanbus**: Commit board state (issues)
  ([`2a1d7eb`](https://github.com/AnthusAI/Apricity/commit/2a1d7ebf9edf2b23147f74a6bc8cdae6f6dc06c9))

- **kanbus**: Commit board state (issues)
  ([`a5d9921`](https://github.com/AnthusAI/Apricity/commit/a5d9921b7b7e47f6ce48bcef7e8235e6cd06bbd1))

- **kanbus**: Commit board state (issues)
  ([`ef1aa77`](https://github.com/AnthusAI/Apricity/commit/ef1aa77ef18ce896f987abacbf661860ffebda26))

- **kanbus**: Commit board state (issues)
  ([`0934496`](https://github.com/AnthusAI/Apricity/commit/0934496ba4d7cdb5c09f8a19e0a3ae7b5946f913))

- **kanbus**: Commit board state (issues)
  ([`6f4297c`](https://github.com/AnthusAI/Apricity/commit/6f4297ce7878ea30af506f2643b65169bf258378))

- **kanbus**: Commit board state (issues)
  ([`e531c67`](https://github.com/AnthusAI/Apricity/commit/e531c6778b13797ef4dc84b17f9e26d1f571f30c))

- **kanbus**: Commit board state (issues)
  ([`7fb8ccb`](https://github.com/AnthusAI/Apricity/commit/7fb8ccb7f3e95566df0acbf4c540f1d53ad59b0d))

- **kanbus**: Commit board state (issues)
  ([`fb1642c`](https://github.com/AnthusAI/Apricity/commit/fb1642c172dc2bdb382d4ebef8c7194f47331cc8))

- **kanbus**: Commit board state (issues)
  ([`b25d66e`](https://github.com/AnthusAI/Apricity/commit/b25d66e2a896d81821e1fdaac567bcb278002f60))

- **kanbus**: Commit board state (issues)
  ([`0a907ac`](https://github.com/AnthusAI/Apricity/commit/0a907ac2eccdc2e0b7c8f6ee6bd4138079a19858))

- **kanbus**: Commit board state (issues)
  ([`6a8359e`](https://github.com/AnthusAI/Apricity/commit/6a8359e09fc05eb6fdd615c8d94650f9656a4a6a))

- **kanbus**: Commit board state (issues)
  ([`6c56cf8`](https://github.com/AnthusAI/Apricity/commit/6c56cf86e025b5ef4736f8e675a37f0108ac9ebf))

- **kanbus**: Commit board state (issues)
  ([`99c9424`](https://github.com/AnthusAI/Apricity/commit/99c9424a23c954522ae5e1d0a083473b9c194ad1))

- **kanbus**: Commit board state (issues)
  ([`b367b32`](https://github.com/AnthusAI/Apricity/commit/b367b32e2eb867318f992b2ef9f7d43b8d93919e))

- **kanbus**: Commit board state (issues)
  ([`74c5516`](https://github.com/AnthusAI/Apricity/commit/74c55166840096fa39a1a06cff5ff1deb4496bb3))

- **kanbus**: Commit board state (issues)
  ([`5e3e3e0`](https://github.com/AnthusAI/Apricity/commit/5e3e3e053f34e066e7f8fcb39f2a122998b7d90f))

- **kanbus**: Commit board state (issues)
  ([`195b018`](https://github.com/AnthusAI/Apricity/commit/195b018c8891c4214cd3c00f54795cab37aabd94))

- **kanbus**: Commit board state (issues)
  ([`64e0fd2`](https://github.com/AnthusAI/Apricity/commit/64e0fd2e85eec69ad695524a3a1b0c7157b96832))

- **kanbus**: Commit board state (issues)
  ([`1fb9485`](https://github.com/AnthusAI/Apricity/commit/1fb9485f9ff7b1cd2ba34d38281a652b357752a3))

- **kanbus**: Commit board state (issues)
  ([`a5fc9c8`](https://github.com/AnthusAI/Apricity/commit/a5fc9c874f94741ea5fe92d885f7270a8c791011))

- **kanbus**: Commit board state (issues)
  ([`97547e0`](https://github.com/AnthusAI/Apricity/commit/97547e01a0c908ec32044849c786d379f16bbe52))

- **kanbus**: Commit board state (issues)
  ([`d146aaa`](https://github.com/AnthusAI/Apricity/commit/d146aaa5105083af5449e79f3519cc48eff81ad3))

- **kanbus**: Commit board state (issues)
  ([`7164d8f`](https://github.com/AnthusAI/Apricity/commit/7164d8f01929834c1583b8f372ca3ffda6982a46))

- **kanbus**: Commit board state (issues)
  ([`d739307`](https://github.com/AnthusAI/Apricity/commit/d739307c9f834ce2535f818f4e47cd440681b233))

- **kanbus**: Commit board state (issues)
  ([`3f3ebac`](https://github.com/AnthusAI/Apricity/commit/3f3ebac764088216681d85b885a0baa274f8295b))

- **kanbus**: Commit board state (issues)
  ([`8a86de8`](https://github.com/AnthusAI/Apricity/commit/8a86de8cec9322b362ad961b1c67fc67705be265))

- **kanbus**: Commit board state (issues)
  ([`318d6fb`](https://github.com/AnthusAI/Apricity/commit/318d6fbdfd7887983e35e9d07633c1b1e8964871))

- **kanbus**: Commit board state (issues)
  ([`5358c74`](https://github.com/AnthusAI/Apricity/commit/5358c743df2d658749780abf208b90f6ab8d6430))

- **kanbus**: Commit board state (issues)
  ([`619b7ee`](https://github.com/AnthusAI/Apricity/commit/619b7eefda992f792f016bef91631cc23137b66c))

- **kanbus**: Commit board state (issues)
  ([`3531cba`](https://github.com/AnthusAI/Apricity/commit/3531cbaf3a903d8e53dac010c8154de54db65869))

- **kanbus**: Commit board state (issues)
  ([`d89a8ab`](https://github.com/AnthusAI/Apricity/commit/d89a8ab8424301d1a5fab7ef8ba9f227a964beca))

- **kanbus**: Commit board state (issues)
  ([`485a115`](https://github.com/AnthusAI/Apricity/commit/485a115e827b814dd3a959383438ab6f7d621917))

- **kanbus**: Commit board state (issues)
  ([`b2986dd`](https://github.com/AnthusAI/Apricity/commit/b2986ddcd7a2f2c8d9d4e9d34537f426e0e76445))

- **kanbus**: Commit board state (issues)
  ([`2681900`](https://github.com/AnthusAI/Apricity/commit/2681900b4cb011eae969d4d2849628395f052bef))

- **kanbus**: Commit board state (issues)
  ([`abb93e4`](https://github.com/AnthusAI/Apricity/commit/abb93e473e639077d2b028fe7020f0bccbe782cb))

- **kanbus**: Commit board state (issues)
  ([`6c9f263`](https://github.com/AnthusAI/Apricity/commit/6c9f26311e4fb8a34dc5c7a1c366b0883d0d8214))

- **kanbus**: Commit board state (issues)
  ([`fc49485`](https://github.com/AnthusAI/Apricity/commit/fc494850ad63da6dcca3b48608708edc579b0b54))

- **kanbus**: Commit board state (issues)
  ([`d8b4299`](https://github.com/AnthusAI/Apricity/commit/d8b429956e9e5cf5a85ed81e9333c87d9f7a3e2b))

- **kanbus**: Commit board state (issues)
  ([`48abb3a`](https://github.com/AnthusAI/Apricity/commit/48abb3a0ce343f8030a04577429cb35b515dc7f5))

- **kanbus**: Commit board state (issues)
  ([`13e960c`](https://github.com/AnthusAI/Apricity/commit/13e960cb2ad480e02686dc663f39c5e68bfb7193))

- **kanbus**: Commit board state (issues)
  ([`6a2317a`](https://github.com/AnthusAI/Apricity/commit/6a2317a23c9906b9e12d966d0421b1b5012be5f4))

- **kanbus**: Commit board state (issues)
  ([`c21d983`](https://github.com/AnthusAI/Apricity/commit/c21d9834be5efc28293d7deeab71a263c45aed8d))

- **kanbus**: Commit board state (issues)
  ([`bebdf6e`](https://github.com/AnthusAI/Apricity/commit/bebdf6e9da28879dbfff0f896bdff7b232fa4694))

- **kanbus**: Commit board state (issues)
  ([`b5b73f2`](https://github.com/AnthusAI/Apricity/commit/b5b73f26355206616f4173f6233047a2a8f72c25))

- **kanbus**: Commit board state (issues)
  ([`5f67438`](https://github.com/AnthusAI/Apricity/commit/5f67438954fd62bf9f97bd4cb1b092363a8ae999))

- **kanbus**: Commit board state (issues)
  ([`1eb1813`](https://github.com/AnthusAI/Apricity/commit/1eb1813c27de22639f0f59a4366c41efe5995041))

- **kanbus**: Commit board state (issues)
  ([`3c742ee`](https://github.com/AnthusAI/Apricity/commit/3c742ee7c7012d36be0d772e2e49f6fe88a138d7))

- **kanbus**: Commit board state (issues)
  ([`f05d9eb`](https://github.com/AnthusAI/Apricity/commit/f05d9ebe7c7ac683f66678630e356e671ffc8f2a))

- **kanbus**: Commit board state (issues)
  ([`9c6d02b`](https://github.com/AnthusAI/Apricity/commit/9c6d02b410839bcc78918e679cda0d7e0656277d))

- **kanbus**: Commit board state (issues)
  ([`76678ae`](https://github.com/AnthusAI/Apricity/commit/76678aefa90ccaadffbafca88a9376805bf3e3b8))

- **kanbus**: Commit board state (issues)
  ([`a19d7e2`](https://github.com/AnthusAI/Apricity/commit/a19d7e28b42dbc82153ab39b5f72a9002576cf51))

- **kanbus**: Commit board state (issues)
  ([`9c5c103`](https://github.com/AnthusAI/Apricity/commit/9c5c103ea6fcb667216bf355fff74ec53f9c9825))

### Documentation

- **apricitus-d4ff90**: Speak of a DAW's words, never name a product
  ([`ce475a3`](https://github.com/AnthusAI/Apricity/commit/ce475a390e0f8503968483ac180ca72f7b1e3f81))

### Features

- **apricitus-13f4c3**: Pitched tracks: one clip played at chosen pitches, as chords or a melody
  ([`c7b859d`](https://github.com/AnthusAI/Apricity/commit/c7b859d5dbc6ae894aeaa3705b4af07f8d5dc892))

- **apricitus-18fbd7**: The home page says what Apricity is now
  ([`d690ed0`](https://github.com/AnthusAI/Apricity/commit/d690ed0b818988ca100cf06890740f1231ab076a))

- **apricitus-2a58f9**: Forks on the Activity page
  ([`5269efb`](https://github.com/AnthusAI/Apricity/commit/5269efb34144dfa42714e2ce066981908d6ff553))

- **apricitus-2e3d70**: Samples show their year
  ([`a1bf899`](https://github.com/AnthusAI/Apricity/commit/a1bf8999748eaae04a6d642efd8e6bec026d5ae4))

- **apricitus-4076e6**: A social preview card
  ([`e44d136`](https://github.com/AnthusAI/Apricity/commit/e44d136051971db10b5fd0bab1bc249c854a2235))

- **apricitus-440ea7**: The play button says what it is waiting for
  ([`833ff92`](https://github.com/AnthusAI/Apricity/commit/833ff9206083df1a1e1fcdeca0554fc564e20dfb))

- **apricitus-443bff**: Forks remember where they came from
  ([`5dbb844`](https://github.com/AnthusAI/Apricity/commit/5dbb8442bc635e6dda64ca4a579031601efcb270))

- **apricitus-4eafac**: The home page hero has no buttons
  ([`c7a5db0`](https://github.com/AnthusAI/Apricity/commit/c7a5db092be37c1606a7e5ce899502202981aabd))

- **apricitus-4f706d**: Curate clips — play, rate and comment on every clip; filter and sort the
  Clips list
  ([`9e3e578`](https://github.com/AnthusAI/Apricity/commit/9e3e5780650cf42c1dfbd5357697d45ecbce0760))

- **apricitus-50ddd6**: A clip's comments open as you work on it
  ([`10fee7e`](https://github.com/AnthusAI/Apricity/commit/10fee7e4af2d54b2ab18366e2ba422c45fa7be26))

- **apricitus-5b91b1**: How it was solved is a tab beside the code
  ([`c064dfa`](https://github.com/AnthusAI/Apricity/commit/c064dfa860af713954b466bc5d5fdd17070345a6))

- **apricitus-6457da**: Groove: score-wide swing, per-note velocity, humanize
  ([`94d45b6`](https://github.com/AnthusAI/Apricity/commit/94d45b6a213bae261ea0e48aa3c6d13d33632472))

- **apricitus-6457da**: The hero groove gets ghost notes, softer in-between hats, a building fill
  and humanize
  ([`19efdee`](https://github.com/AnthusAI/Apricity/commit/19efdee8e46fdd36713c822865aa9b9bb048bff0))

- **apricitus-7173fa**: Two example melodies
  ([`c5ff62f`](https://github.com/AnthusAI/Apricity/commit/c5ff62ffe3bba8c5af78e956415901a7376f2e3e))

- **apricitus-83b881**: A piano roll for Melodies
  ([`0b9daa0`](https://github.com/AnthusAI/Apricity/commit/0b9daa05306b9b8c3a9bd8e9178d3ea1b141d7f2))

- **apricitus-858d49**: Public handles show who made what
  ([`6d92d80`](https://github.com/AnthusAI/Apricity/commit/6d92d802b18a41bac993f15bb7683f53a88973de))

- **apricitus-8ac6bd**: Breakdowns start when first seen
  ([`5901056`](https://github.com/AnthusAI/Apricity/commit/59010567d7646a4335709319255992d7c9d50008))

- **apricitus-8b08c0**: The activity Lambda keeps a card per item
  ([`1eaf310`](https://github.com/AnthusAI/Apricity/commit/1eaf310cc253533b9fb78083cae4306a53f7bbe3))

- **apricitus-93af88**: A Fork button, and lineage you can follow
  ([`8015abf`](https://github.com/AnthusAI/Apricity/commit/8015abf9239f2c4dbbfc61c36a755947820060f7))

- **apricitus-9d5f92**: The top bar's sun rises behind the word, like a halo
  ([`52b27a2`](https://github.com/AnthusAI/Apricity/commit/52b27a25ae7b06fff25e03e5cac01f45cd479593))

- **apricitus-9d5f92**: The top bar's sun sits behind the A, higher
  ([`099709b`](https://github.com/AnthusAI/Apricity/commit/099709b3b7b0c6f4e71ade7260eca40dfb7ce9af))

- **apricitus-9eae1c**: Scores, Beats, Chords, Melodies, Clips and Samples tabs, ranked
  ([`612fa31`](https://github.com/AnthusAI/Apricity/commit/612fa3167dd56b03e36735617b1157e17d48eb31))

- **apricitus-a149ff**: Curated Lomax and Jukebox ragtime imports, denoised by default
  ([`4c5659c`](https://github.com/AnthusAI/Apricity/commit/4c5659c836aae8b7256d8733f244f740923ca953))

- **apricitus-a8c9c3**: One play button, top right, on every page
  ([`e6d7f81`](https://github.com/AnthusAI/Apricity/commit/e6d7f81b2db346485c45747465a27e2a4ea98662))

- **apricitus-ab095b**: Local mode says whose library it is
  ([`2814257`](https://github.com/AnthusAI/Apricity/commit/2814257bf01b61959069ebe52ac2acad3322e585))

- **apricitus-b805c6**: No Reference button on the score bar
  ([`8ac1fdc`](https://github.com/AnthusAI/Apricity/commit/8ac1fdcd8cf5ab4bffa6ebc69683a44da5c77ba1))

- **apricitus-b834fe**: 0-5 star ratings, ranked by time window
  ([`14975fa`](https://github.com/AnthusAI/Apricity/commit/14975fae49859f0d991be96d5c7ea2cb11a347bd))

- **apricitus-bb5d7b**: The Activity page
  ([`99d61d5`](https://github.com/AnthusAI/Apricity/commit/99d61d5d4da88017a1ceb1095518b865395205e7))

- **apricitus-c18450**: Drag the panels to resize them
  ([`b2f7328`](https://github.com/AnthusAI/Apricity/commit/b2f73287bddf53e4cea50add3646f6b57dda4b92))

- **apricitus-c8790a**: Automatic markup finds held notes as hold-N clips
  ([`5509c6a`](https://github.com/AnthusAI/Apricity/commit/5509c6acbaee281d697a71f645f97e0aab5e1e6c))

- **apricitus-d156e7**: Slash chords and a bass role
  ([`a4e7b3c`](https://github.com/AnthusAI/Apricity/commit/a4e7b3ca01621bdaa0ff5d24b85f7e962d3ae0e0))

- **apricitus-d23e2d**: Every sample's license, and credits written for you
  ([`c87a057`](https://github.com/AnthusAI/Apricity/commit/c87a057a1035828fad2f13154f629b28a7e67723))

- **apricitus-db8cd3**: The site is public; sign in to rate and make things
  ([`e3aa21d`](https://github.com/AnthusAI/Apricity/commit/e3aa21db8a19b87141679abfcde0444a9a07fc4c))

- **apricitus-e0210a**: The chord harp: play chords, not notes, with help choosing them
  ([`f90380f`](https://github.com/AnthusAI/Apricity/commit/f90380f4eb9eedf3886e7f7acdca6ee2adbf0abd))

- **apricitus-ed084d**: A general length limit, and playable ccMixter previews
  ([`4eeb687`](https://github.com/AnthusAI/Apricity/commit/4eeb6873fba8d1ae73c4db37fe40bc9adedd6ccb))

- **apricitus-ed084d**: Preview candidates from LoC, ccMixter and the Internet Archive before
  importing
  ([`c51f248`](https://github.com/AnthusAI/Apricity/commit/c51f248b6979bb8ae54ef8ce8424912fc5b9eca8))

- **apricitus-f12662**: Compute and show the combined license of a score's music
  ([`984fd5d`](https://github.com/AnthusAI/Apricity/commit/984fd5d4b1a0dcc0265c989aec4e9d2cfd8d916e))

- **apricitus-f3fecf**: Drum pads take their recording's color
  ([`d13ec8b`](https://github.com/AnthusAI/Apricity/commit/d13ec8b78f27b3b8cf2a75958d1bbdcc451664bd))

- **apricitus-f8ab8b**: Breakdowns get the same play button
  ([`ed3d4c9`](https://github.com/AnthusAI/Apricity/commit/ed3d4c94e2758a5918a10dd52ca0e78921abbd9b))

- **apricitus-f9f1e9**: Threaded comments on scores, samples and clips
  ([`6ea4532`](https://github.com/AnthusAI/Apricity/commit/6ea4532131a94656723e7ee7eba08e44c41d8867))

- **apricitus-faf083**: Deep links — a URL for every page, score, sample, clip and Help page
  ([`e6db6b1`](https://github.com/AnthusAI/Apricity/commit/e6db6b1c0db5444a97d1243869807ec2cc82d5d8))

- **apricitus-fc9ee7**: A drum machine for Beats
  ([`7bcfd31`](https://github.com/AnthusAI/Apricity/commit/7bcfd31d17b9173b30363dcb7e37ee97ae72c0eb))

- **apricitus-ffaf80**: Backfill the Activity page
  ([`55c28f7`](https://github.com/AnthusAI/Apricity/commit/55c28f7ec582b9817095c0d1c4d5d012178288d1))

### Refactoring

- **apricitus-71374c**: Storage tables say Sample and Clip, like the product
  ([`ee51b47`](https://github.com/AnthusAI/Apricity/commit/ee51b47b19923b6814edd631f51d0df3e4e70a99))

### Breaking Changes

- **apricitus-71374c**: A clean break with no aliases. Libraries must be re-migrated (apricity
  migrate) and the cloud tables re-imported from the bucket.


## v0.8.0 (2026-09-25)


## v0.7.0 (2026-09-25)

### Features

- **apricitus-5328b4**: Hero metronome, on until the drums come in
  ([`0a92901`](https://github.com/AnthusAI/Apricity/commit/0a92901b63976f1ecebff9b5344df4792eb7c829))


## v0.6.0 (2026-09-25)

### Chores

- **kanbus**: Commit board state (issues)
  ([`1f3448d`](https://github.com/AnthusAI/Apricity/commit/1f3448d245aaf2a6400f1b4d79a5f7d068ec8bbb))


## v0.5.6 (2026-09-25)


## v0.5.5 (2026-09-25)


## v0.5.4 (2026-09-25)

### Bug Fixes

- **apricitus-4fd2e3**: Reload once when a deploy replaced the lazy chunks; do not block rendering
  on the Google redirect
  ([`35e9de8`](https://github.com/AnthusAI/Apricity/commit/35e9de898aec953105a028d031fc3bd21d17497f))


## v0.5.3 (2026-09-25)


## v0.5.2 (2026-09-25)

### Bug Fixes

- **apricitus-4fd2e3**: Wait for the Google redirect before rendering; members/curators read the
  bucket; account control bottom-left; clearer empty states
  ([`6e1099d`](https://github.com/AnthusAI/Apricity/commit/6e1099d6c72648e80b72c5eb4e5363a88fe964b8))


## v0.5.1 (2026-09-25)


## v0.5.0 (2026-09-25)


## v0.4.0 (2026-09-25)


## v0.3.0 (2026-09-25)


## v0.2.3 (2026-09-25)


## v0.2.2 (2026-09-25)


## v0.2.1 (2026-09-25)


## v0.2.0 (2026-09-25)

### Chores

- **kanbus**: Commit board state (issues)
  ([`85772d6`](https://github.com/AnthusAI/Apricity/commit/85772d6c56c204bf06575fc011e4b0fc54463319))

### Features

- **apricitus-b93d50**: Deployable without Google secrets; hero audio is public; allow-list is an
  env var
  ([`8affc7c`](https://github.com/AnthusAI/Apricity/commit/8affc7cb35caebe059a7666ea70d6d5feda3edf1))


## v0.1.1 (2026-09-25)

### Bug Fixes

- **apricitus-25e216**: Contract lists the library-layout storage paths (files/*, one folder per
  model)
  ([`5fdb90f`](https://github.com/AnthusAI/Apricity/commit/5fdb90fb0eff0663fd5e396376cca89f69bd7cbc))


## v0.1.0 (2026-09-25)

- Initial Release
