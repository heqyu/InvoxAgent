import re
from datetime import datetime, timezone, timedelta

input_file = r"G:\OhMyProjs\InvoxAgent\invox.log"
output_file = r"G:\OhMyProjs\InvoxAgent\invox_local.log"

# 本地时区 UTC+8
local_tz = timezone(timedelta(hours=8))

with open(input_file, "r", encoding="utf-8") as f:
    content = f.read()

# 匹配 ISO 时间 2026-06-01T01:08:11.717Z
pattern = r'(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})Z'

def replace_time(match):
    iso_str = match.group(1)
    dt = datetime.strptime(iso_str, "%Y-%m-%dT%H:%M:%S.%f")
    dt_utc = dt.replace(tzinfo=timezone.utc)
    dt_local = dt_utc.astimezone(local_tz)
    return dt_local.strftime("%m-%d %H:%M:%S.%f")[:-3]  # 毫秒3位

new_content = re.sub(pattern, replace_time, content)

with open(output_file, "w", encoding="utf-8") as f:
    f.write(new_content)

print("Done!")
print(f"Input:  {input_file}")
print(f"Output: {output_file}")
