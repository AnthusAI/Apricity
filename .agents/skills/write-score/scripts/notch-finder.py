#!/usr/bin/env python3
# Usage: notch-finder.py <stems dir> <track> [<track>...]   (run with the analysis venv)
"""Per stem: which exact notes (with octave) sound off the chord, how much, and where: EQ notch candidates."""
import json, sys, pathlib, numpy as np, librosa
d=pathlib.Path(sys.argv[1]); meta=json.load(open(d/'stems.json'))
spb=60/meta['tempo']; off=meta.get('offset_beats',0)
spans=meta['harmony']
names=librosa.midi_to_note(range(36,96),unicode=False)
for stem in sys.argv[2:]:
    y,sr=librosa.load(d/f'{stem}.wav',sr=22050,mono=True)
    h=librosa.effects.harmonic(y,margin=3.0)
    C=np.abs(librosa.cqt(h,sr=sr,fmin=librosa.midi_to_hz(36),n_bins=60,hop_length=512))
    t=librosa.frames_to_time(np.arange(C.shape[1]),sr=sr,hop_length=512)
    total=C.sum(); acc={}
    for sp in spans:
        PC={'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11}
        tones={PC[x] if isinstance(x,str) else x for x in (sp.get('chord_tones') or [])}
        if not tones: continue
        a=(sp['start_beat']-off)*spb; b=(sp['end_beat']-off)*spb
        m=(t>=a)&(t<b)
        if not m.any(): continue
        e=np.median(C[:,m],axis=1)*m.sum()
        for i in range(60):
            if (36+i)%12 not in tones and e[i]>0:
                k=names[i]; acc.setdefault(k,[0,set()]); acc[k][0]+=e[i]; acc[k][1].add(sp['label'].split(' (')[1].rstrip(')'))
    print(f"== {stem}: off-chord notes by energy (share of the stem's sustained energy)")
    for k,(v,ch) in sorted(acc.items(),key=lambda x:-x[1][0])[:6]:
        hz=librosa.note_to_hz(k); print(f"   {k:4} {hz:7.1f} Hz  {100*v/total:5.1f}%   under {', '.join(sorted(ch))}")
