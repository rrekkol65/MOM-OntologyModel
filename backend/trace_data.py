import json


DEMO = {
    "title": "设备 001",
    "demo": True,
    "nodes": [
        {"id": "device", "label": "设备 001", "kind": "设备实例", "details": "设备编号 001，演示用设备。"},
        {"id": "ledger", "label": "设备台账", "kind": "设备管理", "details": "维护设备编号、名称和归属产线。"},
        {"id": "runtime", "label": "设备运行统计", "kind": "运行统计", "details": "按设备编号归集运行时长和停机时长。"},
        {"id": "oee", "label": "OEE 分析", "kind": "生产绩效", "details": "使用运行统计计算时间开动率，并结合性能和质量数据计算 OEE。"},
    ],
    "edges": [
        {"from": "device", "to": "ledger", "label": "登记设备实例", "details": "以设备编号 001 关联台账。"},
        {"from": "ledger", "to": "runtime", "label": "引用设备主数据", "details": "按设备编号匹配设备名称及所属产线。"},
        {"from": "runtime", "to": "oee", "label": "提供运行及停机时长", "details": "按同一设备及统计周期提供时间开动率的输入。"},
    ],
    "focus": "device",
}


def validate_graph(graph):
    if not isinstance(graph["title"], str):
        raise ValueError("Invalid graph title")
    nodes, edges = graph["nodes"], graph["edges"]
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise ValueError("Invalid graph collections")
    ids = set()
    for node in nodes:
        if any(not isinstance(node[field], str) or not node[field].strip()
               for field in ("id", "label", "kind")) or node["id"] in ids:
            raise ValueError("Invalid or duplicate node")
        ids.add(node["id"])
    for edge in edges:
        if edge["from"] not in ids or edge["to"] not in ids or not isinstance(edge["label"], str):
            raise ValueError("Invalid relationship")
    if graph.get("focus") is not None and graph["focus"] not in ids:
        raise ValueError("Invalid focus")
    return graph


TRACE_TYPES = {
    "master": {"person", "equipment", "material"},
    "business": {"batch", "document"},
}


def read_trace(directory, mode, object_id, trace_type="", category=""):
    typed = bool(trace_type or category)
    if typed and (mode != "object" or category not in TRACE_TYPES.get(trace_type, set())):
        return 400, {"error": "无效的数据类型或细分类"}
    if typed and directory is None:
        return 503, {"error": "实际业务数据尚未接入。可查看原型及本分类的接入要求。"}
    if mode == "demo":
        return 200, DEMO
    if mode == "object" and (not object_id or len(object_id) > 120):
        return 400, {"error": "请输入有效的业务对象编号"}
    if mode not in {"overview", "object"}:
        return 400, {"error": "无效的查询方式"}
    if directory is None:
        if mode == "overview":
            return 200, {
                "title": "设备业务流程总览",
                "demo": True,
                "nodes": DEMO["nodes"][1:],
                "edges": DEMO["edges"][1:],
            }
        if object_id == "001":
            return 200, DEMO
        return 404, {"error": "未找到该对象。当前可查询模拟设备 001。"}
    try:
        if mode == "overview":
            path = directory / "overview.json"
        else:
            # Hex encoding keeps business identifiers out of the filesystem path syntax.
            objects = directory / "objects"
            if typed:
                objects = objects / trace_type / category
            path = objects / (object_id.encode("utf-8").hex() + ".json")
        graph = validate_graph(json.loads(path.read_text(encoding="utf-8-sig")))
    except FileNotFoundError:
        message = "未找到该对象的追溯记录" if mode == "object" else "尚未接入系统总览数据"
        return 404, {"error": message}
    except (OSError, ValueError, TypeError, KeyError):
        return 500, {"error": "业务追溯数据读取失败，请检查数据源及图谱格式"}
    return 200, graph
