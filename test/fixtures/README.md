# Synthetic preview media

`preview.mp4` is a 40-second synthetic test pattern and 440 Hz sine wave generated
locally with FFmpeg. It contains no downloaded video, session or account data.
The fragmented tracks below exercise the production MediaSource pipeline, AAC
decoding in the restored 0.89.0 reader. No YouTube player API is simulated.
The rejected seek/failure experiments are archived outside runtime.

Regenerate using an installed FFmpeg:

```sh
ffmpeg -f lavfi -i "testsrc2=size=160x90:rate=5:duration=40" -f lavfi -i "sine=frequency=440:sample_rate=22050:duration=40" -c:v libx264 -preset veryfast -crf 32 -g 5 -pix_fmt yuv420p -c:a aac -b:a 24k -movflags +faststart -shortest -y test/fixtures/preview.mp4
ffmpeg -i test/fixtures/preview.mp4 -an -c:v libx264 -preset veryfast -g 5 -bf 0 -crf 32 -movflags +dash+global_sidx -frag_duration 1000000 -y test/fixtures/preview-video.mp4
ffmpeg -i test/fixtures/preview.mp4 -vn -c:a aac -b:a 24k -movflags +dash+global_sidx -frag_duration 1000000 -y test/fixtures/preview-audio.mp4
```

The test server supports HTTP and query byte ranges. A server that returns the whole file
as 200 for every range can reset seeks to the beginning and invalidate playback
tests. This fixture and storyboard SVG are excluded from runtime ZIPs.

# Real feed metadata

`real-feed.json` holds public metadata for six well known channels, read on
8 October 2026 through the same `UULF` Atom feeds the extension collects with,
plus one public player record per video for its duration and its canonical URL.
Titles, view counts, publication dates and ids are facts; nothing is attributed
to a channel that did not publish it, and the `UULF` prefix means no Short is in
there.

It dresses `?thumbs` on the feed and sorting benches, which is what
`tools/shoot.py` photographs for the README. Thumbnails are fetched from
`i.ytimg.com` at render time, so that mode needs the network. Avatars are cached
under `.avatars/`, which is not in the repository: those are other people's
pictures, and they belong on their own servers.
