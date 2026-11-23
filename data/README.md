# Recordings

Put your phyphox exports here (or CSVs saved from the phone app).

Name each file `exercise_reps_start_take.csv`, for example `squat_10_top_01.csv` or `curl_12_bottom_02.csv`. The scripts read the exercise, the hand count, and the start position from the name. Files saved from the phone app are named like `squat_top_20261124-1830.csv`, so add the hand count after recording: `squat_10_top_20261124-1830.csv`.

To compare phase times with video, add `<same name>_video.csv` next to the recording (format in the main README).

Then run `python evaluate.py data/` from the repository root.
