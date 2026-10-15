"""只读 PNG 生成动作图集元数据，不编辑图片像素。"""
import json
import sys
from pathlib import Path
from PIL import Image

ROOT = Path("/Volumes/ORICO/project/memory-pet/frontend/public/assets")
action = sys.argv[1]
path = ROOT / f"panda-anim-{action}.png"
image = Image.open(path)
alpha = image.getchannel("A")
# 生成器可能把中间留白偏移几像素，按真实透明缝定位分隔线，避免截断相邻帧。
opaque = alpha.point(lambda value: 255 if value > 180 else 0)
def split_axis(horizontal):
    dimension = image.height if horizontal else image.width
    candidates = []
    start = None
    for index in range(round(dimension/2)-55, round(dimension/2)+56):
        box = (0,index,image.width,index+1) if horizontal else (index,0,index+1,image.height)
        empty = opaque.crop(box).getbbox() is None
        if empty and start is None:
            start = index
        if not empty and start is not None:
            candidates.append((start,index));start = None
    if start is not None:
        candidates.append((start,round(dimension/2)+56))
    candidates = [pair for pair in candidates if pair[1]-pair[0] >= 4]
    if not candidates:
        raise SystemExit("中间没有可靠透明分隔缝，需要重新生成")
    begin,end = min(candidates,key=lambda pair:abs((pair[0]+pair[1])/2-dimension/2))
    return round((begin+end)/2)
xs = [0,split_axis(False),image.width]
ys = [0,split_axis(True),image.height]
frames = []
for row in range(2):
    for column in range(2):
        x0,y0,x1,y1 = xs[column],ys[row],xs[column+1],ys[row+1]
        bounds = alpha.crop((x0, y0, x1, y1)).point(lambda value: 255 if value > 180 else 0).getbbox()
        if bounds is None:
            raise SystemExit("动作帧为空")
        if min(bounds[0], bounds[1], x1-x0-bounds[2], y1-y0-bounds[3]) < 3:
            raise SystemExit(f"帧边界过近或截断，需要重新生成：{row},{column},{bounds}")
        frames.append({
            "x": x0, "y": y0, "width": x1-x0, "height": y1-y0,
            "contentBounds": list(bounds), "anchorX": (image.width/4 if column == 0 else image.width*3/4)-x0, "anchorY": bounds[3]
        })
manifest_path = ROOT / "panda-animation.json"
manifest = json.loads(manifest_path.read_text())
sheet_id = f"{action}-hi"
manifest["sheets"] = [sheet for sheet in manifest["sheets"] if sheet["id"] != sheet_id]
manifest["sheets"].append({
    "id": sheet_id, "url": f"/assets/{path.name}", "width": image.width, "height": image.height,
    "columns": 2, "rows": 2, "alpha": alpha.getextrema()[0] == 0
})
old = manifest["actions"][action]
manifest["actions"][action] = {**old, "sheet": sheet_id, "frames": frames}
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
print(json.dumps({"action": action, "size": image.size, "mode": image.mode,
                  "alpha": alpha.getextrema(), "frames": frames}, ensure_ascii=False))
