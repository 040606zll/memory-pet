"""生成真实 RML 矢量熊猫和时间线；只使用官方 schema 已核实的类型。"""
from pathlib import Path
from math import radians
import xml.etree.ElementTree as ET

ROOT = Path(__file__).parent
NS = {"version": "1", "kind": "fragment"}
CREAM = ["FFFFFDF5", "FFF3EEE3", "FFD6DEE1"]
DARK = ["FF4A5F73", "FF253447", "FF142231"]
PINK = ["FFF4C3B4", "FFD69A91", "FFBA807C"]

def tag(parent, kind, **attrs):
    return ET.SubElement(parent, kind, {key: str(value) for key, value in attrs.items()})

def paint(shape, colors, width, height, feather=0):
    fill = tag(shape, "Fill", name="柔和渐变", fillRule="clockwise")
    if len(colors) == 1:
        tag(fill, "SolidColor", colorValue=colors[0], name="颜色")
    else:
        gradient = tag(fill, "RadialGradient", startX=-width*.20, startY=-height*.22,
                       endX=width*.64, endY=height*.32, name="立体柔光")
        for index, color in enumerate(colors):
            tag(gradient, "GradientStop", colorValue=color, position=index/(len(colors)-1))
    if feather:
        tag(fill, "Feather", strength=feather, name="柔和边缘")

def ellipse(parent, name, x, y, width, height, colors, identity=None, rotation=0, opacity=1, feather=0):
    attrs = dict(name=name, x=x, y=y, rotation=rotation, opacity=opacity)
    if identity is not None: attrs["id"] = f"0:{identity}"
    shape = tag(parent, "Shape", **attrs)
    tag(shape, "Ellipse", width=width, height=height, name="矢量轮廓")
    paint(shape, colors, width, height, feather)
    return shape

def curve(parent, name, x, y, points, color, thickness=3, identity=None, opacity=1):
    attrs = dict(name=name, x=x, y=y, opacity=opacity)
    if identity is not None: attrs["id"] = f"0:{identity}"
    shape = tag(parent, "Shape", **attrs)
    path = tag(shape, "PointsPath", isClosed="false", name="曲线")
    for px, py, angle, distance in points:
        tag(path, "CubicMirroredVertex", x=px, y=py, rotation=angle, distance=distance)
    stroke = tag(shape, "Stroke", thickness=thickness, cap="round", join="round", name="线条")
    tag(stroke, "SolidColor", colorValue=color, name="颜色")
    return shape

def foot(parent, x, y, name):
    node = tag(parent, "Node", x=x, y=y, rotation=.10 if x<320 else -.10, name=name)
    for dx, dy, size in [(-32,-26,18),(-10,-36,20),(13,-34,20),(34,-21,18)]:
        ellipse(node,"趾垫",dx,dy,size,size*1.25,PINK)
    ellipse(node,"掌心软垫",0,12,57,61,PINK)
    ellipse(node,"后足",0,0,117,115,DARK,feather=1.2)

def arm(parent, x, y, name, identity, pad_id):
    node = tag(parent,"Node",x=x,y=y,rotation=.18 if x<320 else -.18,name=name,id=f"0:{identity}")
    pads = tag(node,"Node",x=0,y=116,opacity=0,name="抬爪掌垫",id=f"0:{pad_id}")
    for dx,dy,size in [(-21,-17,13),(-7,-26,14),(10,-25,14),(24,-13,12)]:
        ellipse(pads,"爪趾",dx,dy,size,size*1.15,PINK)
    ellipse(pads,"爪心",0,7,42,44,PINK)
    ellipse(node,"爪部高光",-17,66,17,80,["154F6A83"],rotation=-.1,feather=8)
    ellipse(node,"柔软前肢",0,71,87,160,DARK,feather=1.2)
    return node

def number_condition(transition, value):
    condition = tag(transition,"TransitionViewModelCondition",opValue="equal")
    left = tag(condition,"TransitionPropertyViewModelComparator")
    typed = tag(left,"BindablePropertyNumber")
    tag(typed,"DataBindContext",sourcePathIds="0:40-0:42",propertyKey=636)
    tag(condition,"TransitionValueNumberComparator",value=value)

def trigger_condition(transition):
    condition = tag(transition,"TransitionViewModelCondition",opValue="equal")
    left = tag(condition,"TransitionPropertyViewModelComparator")
    typed = tag(left,"BindablePropertyTrigger")
    tag(typed,"DataBindContext",sourcePathIds="0:40-0:43",propertyKey=686)
    tag(condition,"TransitionValueTriggerComparator",value=0)

def write(root, filename):
    ET.indent(root, space="  ")
    path = ROOT/filename
    path.write_text(ET.tostring(root,encoding="unicode")+"\n")
    if len(path.read_text().splitlines())>=1000:
        raise RuntimeError(f"文件行数过大：{filename}")

root = ET.Element("Rive",NS)
ab = tag(root,"Artboard",width=640,height=700,name="Panda",id="0:2",
         defaultStateMachineId="0:7",viewModelId="0:40",viewModelInstanceId="0:41",styleId="0:3")
tag(ab,"LayoutComponentStyle",name="画板样式",id="0:3")
rig = tag(ab,"Node",x=0,y=650,name="熊猫整体呼吸",id="0:100")
# Rive 首声明的 Shape 位于前景，因此先前肢/头部，最后躯干。
arm(rig,211,405-650,"左前肢肩关节",110,111)
arm(rig,429,405-650,"右前肢肩关节",112,113)
head = tag(rig,"Node",x=320,y=271-650,rotation=.07,name="独立头部",id="0:120")
# 鼻口优先绘制，眼睑与眼球分别独立，眨眼通过矢量缩放与曲线显隐实现。
ellipse(head,"鼻尖光点",-5,57,14,5,["88FFF7E7"])
nose = tag(head,"Shape",x=0,y=68,name="圆润鼻子")
path = tag(nose,"PointsPath",isClosed="true",isClockwise="true",name="鼻轮廓")
for x,y in [(-22,-11),(22,-11),(0,17)]:tag(path,"StraightVertex",x=x,y=y,radius=10)
paint(nose,PINK,44,31)
curve(head,"嘴中央",0,96,[(0,-15,1.57,4),(0,0,1.57,4)],"FF8E665F",2.5)
curve(head,"温柔微笑",0,96,[(-23,-2,.6,8),(0,5,0,8),(23,-2,-.6,8)],"FF8E665F",3)
ellipse(head,"开心嘴内部",0,106,42,26,["FF7C4B50"],identity=126,opacity=0)
ellipse(head,"小舌头",0,115,26,9,["FFF2ADAF"],identity=127,opacity=0)
for side,x in [("左",-76),("右",76)]:
    eye_id = 122 if x<0 else 123
    lid_id = 124 if x<0 else 125
    curve(head,f"{side}闭眼弧线",x,22,[(-16,0,.22,5),(0,5,0,6),(16,0,-.22,5)],
          "FF9EB6C4",3.8,identity=lid_id,opacity=0)
    eye = tag(head,"Node",x=x,y=22,name=f"{side}眼睛",id=f"0:{eye_id}")
    ellipse(eye,"小高光",7,6,5,5,["DDEAF8FF"])
    ellipse(eye,"大高光",-7,-10,11,12,["FFFEFFFF"])
    ellipse(eye,"瞳孔",0,1,21,27,["FF08141F"])
    ellipse(eye,"虹膜",0,0,37,44,["FF77A5B5","FF29455E","FF0C1D2C"])
    ellipse(head,f"{side}眼圈",x,16,80,104,DARK,rotation=.31 if x<0 else -.31,feather=1.2)
    ellipse(head,f"{side}脸腮",x*1.23,65,47,23,["35EDAEA6"],feather=11)
ellipse(head,"圆润口鼻区域",0,81,147,78,["FFFDFBF2","FFF2EADD"],feather=6)
# 极少量轮廓绒团保留幼年熊猫柔软观感，不引入图片纹理。
for x,y,w,h in [(-34,-145,40,25),(0,-153,39,23),(33,-147,35,24),(-158,-11,23,40),(160,5,24,40)]:
    ellipse(head,"柔软绒团",x,y,w,h,CREAM,feather=3)
ellipse(head,"奶白圆脸",0,0,350,308,CREAM,feather=1.8)
for x in [-139,139]:
    ellipse(head,"耳内柔光",x,-117,48,50,["FF718191","FF37485A"])
    ellipse(head,"黑色圆耳",x,-117,87,88,DARK,feather=1.5)
foot(rig,235,593-650,"左后足")
foot(rig,405,593-650,"右后足")
body = tag(rig,"Node",x=320,y=486-650,name="胸腹",id="0:130")
ellipse(body,"胸口柔光",-19,-44,85,100,["2CFFFFFF"],feather=18)
ellipse(body,"奶白腹部",0,20,242,249,CREAM,feather=2)
ellipse(body,"黑色肩胸",0,-70,276,156,DARK,feather=2)
ellipse(body,"圆润躯干",0,0,288,286,CREAM,feather=1.5)

sm = tag(ab,"StateMachine",name="Panda",id="0:7")
base = tag(sm,"StateMachineLayer",name="常驻自然呼吸",id="0:8")
tag(base,"AnyState",x=0,y=-140);tag(base,"ExitState",x=450,y=-140)
entry=tag(base,"EntryState",x=0,y=0);tag(entry,"StateTransition",stateToId="0:500")
tag(base,"AnimationState",animationId="0:200",id="0:500",x=200,y=0)
layer = tag(sm,"StateMachineLayer",name="动作与表情",id="0:9")
any_state = tag(layer,"AnyState",x=160,y=-240)
tag(layer,"ExitState",x=1050,y=-240)
entry=tag(layer,"EntryState",x=0,y=0);tag(entry,"StateTransition",stateToId="0:501")
idle = tag(layer,"AnimationState",animationId="0:201",id="0:501",x=180,y=0,reset="true")
actions=[("blink",33),("wave",108),("nod",75),("shake_head",90),("stretch",168),("happy",114),("sleep",240)]
for number,(name,duration) in enumerate(actions,1):
    transition=tag(any_state,"StateTransition",stateToId=f"0:{501+number}",duration=140)
    number_condition(transition,number);trigger_condition(transition)
    state=tag(layer,"AnimationState",animationId=f"0:{201+number}",id=f"0:{501+number}",
              reset="true",x=400+(number%3)*240,y=(number//3)*160+80)
    tag(state,"StateTransition",stateToId="0:501",duration=180,enableExitTime="true",
        exitTimeIsPercetange="true",exitTime=100)
# 通过 action=0 + perform 可以立即平滑回 idle。
transition=tag(any_state,"StateTransition",stateToId="0:501",duration=180)
number_condition(transition,0);trigger_condition(transition)

vm=tag(root,"ViewModel",name="PandaControl",id="0:40",defaultInstanceId="0:41")
tag(vm,"ViewModelPropertyNumber",name="action",id="0:42")
tag(vm,"ViewModelPropertyTrigger",name="perform",id="0:43")
instance=tag(vm,"ViewModelInstance",name="Default",id="0:41",exports="true")
tag(instance,"ViewModelInstanceNumber",viewModelPropertyId="0:42",propertyValue=0)
tag(instance,"ViewModelInstanceTrigger",viewModelPropertyId="0:43",propertyValue=0)
write(root,"scene.rml")

TIMELINES=[]
BASE={120:{13:320,14:271-650,15:.07,16:1,17:1},110:{15:.18},112:{15:-.18},
      111:{18:0},113:{18:0},122:{17:1},123:{17:1},124:{18:0},125:{18:0},126:{18:0},127:{18:0}}

def animation(name, identity, duration, tracks, loop="oneShot", defaults=True):
    root=ET.Element("Rive",NS)
    anim=tag(root,"LinearAnimation",artboardId="0:2",name=name,id=f"0:{identity}",fps=60,
             duration=duration,loopValue=loop)
    properties={}
    if defaults:
        properties={object_id:{key:[(0,value),(duration,value)] for key,value in values.items()}
                    for object_id,values in BASE.items()}
    for object_id,values in tracks.items():properties.setdefault(object_id,{}).update(values)
    for object_id,values in properties.items():
        obj=tag(anim,"KeyedObject",objectId=f"0:{object_id}")
        for key,frames in values.items():
            prop=tag(obj,"KeyedProperty",propertyKey=key)
            for frame,value in frames:
                k=tag(prop,"KeyFrameDouble",frame=frame,value=value,interpolationType="cubic")
                tag(k,"CubicEaseInterpolator",x1=.42,y1=0,x2=.58,y2=1)
    write(root,f"animation-{name}.rml")
    # 编译器当前必须让时间线成为 Artboard 真正的子元素，单写 artboardId 不足以导出。
    def strip_whitespace(element):
        element.text=None;element.tail=None
        for child in element:strip_whitespace(child)
    strip_whitespace(anim)
    anim.attrib.pop("artboardId",None)
    TIMELINES.append(ET.tostring(anim,encoding="unicode"))

animation("breathing",200,240,{100:{17:[(0,1),(120,1.012),(240,1)]}},"loop",False)
animation("idle",201,240,{120:{15:[(0,.07),(70,.09),(150,.035),(240,.07)]},
                         110:{15:[(0,.18),(120,.21),(240,.18)]}},"loop")
animation("blink",202,33,{122:{17:[(0,1),(9,.08),(16,.08),(27,1),(33,1)]},
                          123:{17:[(0,1),(9,.08),(16,.08),(27,1),(33,1)]},
                          124:{18:[(0,0),(8,1),(18,1),(26,0),(33,0)]},
                          125:{18:[(0,0),(8,1),(18,1),(26,0),(33,0)]}})
animation("wave",203,108,{110:{15:[(0,.18),(26,2.68),(42,2.43),(58,2.82),(74,2.43),(90,2.68),(108,.18)]},
                          111:{18:[(0,0),(22,1),(88,1),(108,0)]},
                          120:{15:[(0,.07),(25,-.02),(85,-.02),(108,.07)]}})
animation("nod",204,75,{120:{14:[(0,-379),(17,-361),(29,-373),(43,-361),(59,-373),(75,-379)],
                           17:[(0,1),(17,.94),(29,1),(43,.94),(59,1),(75,1)]}})
animation("shake_head",205,90,{120:{13:[(0,320),(22,301),(45,339),(67,310),(90,320)],
                                    15:[(0,.07),(22,-.09),(45,.19),(67,-.04),(90,.07)],
                                    16:[(0,1),(22,.95),(45,.95),(67,.98),(90,1)]}})
animation("stretch",206,168,{110:{15:[(0,.18),(42,2.88),(72,2.7),(111,2.88),(168,.18)]},
                             112:{15:[(0,-.18),(42,-2.65),(72,-2.5),(111,-2.65),(168,-.18)]},
                             111:{18:[(0,0),(32,1),(120,1),(168,0)]},
                             113:{18:[(0,0),(32,1),(120,1),(168,0)]},
                             120:{15:[(0,.07),(58,.13),(115,.13),(168,.07)]}})
animation("happy",207,114,{110:{15:[(0,.18),(28,2.1),(53,2.4),(77,2.08),(114,.18)]},
                            112:{15:[(0,-.18),(28,-2.1),(53,-2.4),(77,-2.08),(114,-.18)]},
                            111:{18:[(0,0),(20,1),(85,1),(114,0)]},
                            113:{18:[(0,0),(20,1),(85,1),(114,0)]},
                            126:{18:[(0,0),(20,1),(89,1),(114,0)]},
                            127:{18:[(0,0),(20,1),(89,1),(114,0)]},
                            120:{14:[(0,-379),(30,-387),(54,-379),(78,-387),(114,-379)]}})
animation("sleep",208,240,{122:{17:[(0,1),(40,.04),(196,.04),(240,1)]},
                            123:{17:[(0,1),(40,.04),(196,.04),(240,1)]},
                            124:{18:[(0,0),(40,1),(196,1),(240,0)]},
                            125:{18:[(0,0),(40,1),(196,1),(240,0)]},
                            120:{15:[(0,.07),(50,.24),(100,.23),(160,.24),(196,.23),(240,.07)],
                                 14:[(0,-379),(50,-365),(196,-365),(240,-379)]}})
scene_path=ROOT/"scene.rml"
scene_path.write_text(scene_path.read_text().replace("  </Artboard>","\n".join("    "+t for t in TIMELINES)+"\n  </Artboard>"))
if len(scene_path.read_text().splitlines())>=1000:raise RuntimeError("场景文件过大")
print("已生成纯矢量 RML：scene + breathing + 八动作，未引用位图或脚本。")
