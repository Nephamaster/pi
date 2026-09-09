#!/usr/bin/env python3
"""Validate this asset package and optionally the companion ProcessSpec package.
Requires: PyYAML and jsonschema. Mirrors the supplied strict TypeBox schemas;
this is not a substitute for compiling an actual Workflow with the project Compiler.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path
import yaml
from jsonschema import Draft202012Validator

S = {"type": "string", "minLength": 1}
ID = {**S, "maxLength": 128, "pattern": "^[A-Za-z][A-Za-z0-9._-]*$"}
V = {**S, "maxLength": 64, "pattern": r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$"}
def arr(item=S, **kw): return {"type": "array", "items": item, **kw}
def obj(props, required=None):
    return {"type":"object", "properties":props, "required":list(props) if required is None else required, "additionalProperties":False}
CARD = obj({
    "id": ID, "version": V, "name": S, "description": S,
    "responsibilities": arr(minItems=1), "nonResponsibilities": arr(),
    "capabilities": arr(ID, minItems=1), "applicableScenarios":arr(),
    "principles":arr(), "deliverables":arr(),
    "promptProfile":obj({"approach":arr(minItems=1),"communication":arr(minItems=1),"verification":arr(minItems=1)}),
    "knowledgeBases":arr(obj({"id":ID,"description":S,"paths":arr(uniqueItems=True)},["id","description"])),
    "model":obj({"selection":{"enum":["run_default","explicit"]},"provider":ID,"id":S,
                 "thinkingLevel":{"enum":["off","minimal","low","medium","high","xhigh","max","inherit"]}},[]),
    "skills":arr(ID),"tools":arr(ID),
    "permissions":obj({"workspace":{"enum":["read","write"]},"readScopes":arr(),"writeScopes":arr(),"externalActions":{"type":"boolean"}},[]),
},["id","name","description","responsibilities","nonResponsibilities","capabilities"])
PROCESS = obj({
 "schema_version":{"const":1},"process_spec_id":ID,"version":V,"name":S,"description":S,"source":S,
 "applicable_when":arr(minItems=1),"not_applicable_when":arr(),
 "required_activities":arr(obj({"activity_id":ID,"description":S,"required_capabilities":arr(ID,uniqueItems=True)})),
 "required_deliverables":arr(obj({"deliverable_id":ID,"activity_id":ID,"artifact_type":ID,"description":S,"evidence_requirements":arr()},["deliverable_id","activity_id","description","evidence_requirements"])),
 "required_reviews":arr(obj({"review_id":ID,"deliverable_id":ID,"description":S,"reviewer_capabilities":arr(ID,minItems=1,uniqueItems=True),"independent_agent":{"type":"boolean"},"criteria":arr(minItems=1)})),
 "workflow_rules":arr(obj({"rule_id":ID,"description":S,"enforced_by":{"enum":["compiler","runtime","review"]}})),
})
CATEGORIES = set('academic design engineering finance game-development gis healthcare marketing paid-media product project-management research sales security spatial-computing specialized support testing'.split())
BUILTINS = {'read','write','edit','bash','grep','find','ls','powershell'}

def check_schema(schema, data, filename):
    errors = sorted(Draft202012Validator(schema).iter_errors(data),key=lambda e:str(e.path))
    if errors:
        raise ValueError(str(filename)+': '+ '; '.join('/'.join(map(str,e.path))+': '+e.message for e in errors))

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--roles',type=Path,default=Path(__file__).resolve().parents[1])
    p.add_argument('--process',type=Path)
    p.add_argument('--output',type=Path)
    a=p.parse_args()
    cards={}; sizes=[]; lines=[]
    for f in sorted((a.roles/'agent-cards').glob('*.yaml')):
        data=yaml.safe_load(f.read_text(encoding='utf-8')); check_schema(CARD,data,f)
        assert data['id'] not in cards, f'duplicate role id {data["id"]}'
        assert len(data['capabilities'])==len(set(data['capabilities']))
        assert set(data['tools'])<=BUILTINS
        assert data['permissions']['externalActions'] is False
        assert data['skills']==[] and data['knowledgeBases']==[]
        cards[data['id']]=data; sizes.append(f.stat().st_size); lines.append(len(f.read_text().splitlines()))
    prov=json.loads((a.roles/'metadata/role-provenance.json').read_text())
    assert len(cards)==42==len(prov['roles'])
    counts=Counter(r['category'] for r in prov['roles']); assert set(counts)==CATEGORIES
    assert len({r['source']['path'] for r in prov['roles']})==42
    assert {r['id'] for r in prov['roles']}==set(cards)
    for r in prov['roles']:
        assert r['source']['commit']==prov['source_commit']
        assert re.fullmatch('[a-f0-9]{40}',r['source']['blob_sha1'])
        assert (a.roles/r['generated_file']).is_file()
        assert hashlib.sha256((a.roles/r['generated_file']).read_bytes()).hexdigest()==r['generated_sha256']
    reviewer=cards['agency-engineering-code-reviewer']
    assert reviewer['permissions']['workspace']=='read' and reviewer['permissions']['writeScopes']==[]
    assert not set(reviewer['tools'])&{'write','edit','bash','powershell'}
    result={'role_schema_checks':len(cards),'category_count':len(counts),'categories':dict(sorted(counts.items())),
            'source_provenance_checks':42,'source_commit':prov['source_commit'],
            'role_bytes':{'min':min(sizes),'max':max(sizes),'total':sum(sizes)},
            'role_lines':{'min':min(lines),'max':max(lines)},
            'validation_scope':'Python strict JSON Schema mirror plus local consistency checks; not original TypeBox/Workflow Compiler or real Pi execution'}
    if a.process:
        specs={}; spec_results=[]
        for f in sorted((a.process/'process-specs').glob('*.yaml')):
            s=yaml.safe_load(f.read_text()); check_schema(PROCESS,s,f)
            assert s['process_spec_id'] not in specs; specs[s['process_spec_id']]=s
            acts={x['activity_id']:x for x in s['required_activities']}
            ds={x['deliverable_id']:x for x in s['required_deliverables']}
            rs={x['review_id']:x for x in s['required_reviews']}
            rules={x['rule_id']:x for x in s['workflow_rules']}
            assert len(acts)==len(s['required_activities']) and len(ds)==len(s['required_deliverables'])
            assert len(rs)==len(s['required_reviews']) and len(rules)==len(s['workflow_rules'])
            assert all(x['activity_id'] in acts for x in ds.values())
            assert all(x['deliverable_id'] in ds for x in rs.values())
            assert set(acts)=={x['activity_id'] for x in ds.values()}
            assert set(ds)=={x['deliverable_id'] for x in rs.values()}
            assert all(x['enforced_by']=='review' for x in rules.values())
            caps={c for x in cards.values() for c in x['capabilities']}
            need={c for x in acts.values() for c in x['required_capabilities']}|{c for x in rs.values() for c in x['reviewer_capabilities']}
            spec_results.append({'id':s['process_spec_id'],'activities':len(acts),'deliverables':len(ds),'reviews':len(rs),'semantic_rules':len(rules),'unmatched_capabilities':sorted(need-caps)})
        assert len(specs)==2
        mapping=json.loads((a.process/'metadata/software-role-mapping.json').read_text())
        soft=specs['huawei-ptm-derived-api-release-assessment']
        acts={x['activity_id']:x for x in soft['required_activities']}
        gates={x['review_id']:x for x in soft['required_reviews']}
        assert len(mapping)==14 and {x['activity_id'] for x in mapping}==set(acts)
        graph={x['activity_id']:x['prerequisites'] for x in mapping}
        for x in mapping:
            producer=cards[x['candidate_producer']]; reviewer=cards[x['candidate_reviewer']]
            assert x['required_capability'] in producer['capabilities']
            assert set(acts[x['activity_id']]['required_capabilities'])<=set(producer['capabilities'])
            gate=gates[x['gate_id']]
            assert gate['deliverable_id']==x['deliverable_id']
            assert set(gate['reviewer_capabilities'])<=set(reviewer['capabilities'])
            assert x['reviewer_capability'] in reviewer['capabilities']
            assert producer['id']!=reviewer['id'] and gate['independent_agent']
            assert set(x['prerequisites'])<=set(acts)
        done=set()
        while len(done)<len(graph):
            ready={k for k,v in graph.items() if k not in done and set(v)<=done}
            assert ready,'cycle in advisory dependency mapping'
            done|=ready
        model=yaml.safe_load((a.process/'reference-model/huawei-ipd-ptm-public-reference.yaml').read_text())
        inventory=model['source_facts']['activity_inventory']
        assert len(inventory)==16 and len({x['id'] for x in inventory})==16
        source_ids={x['id'] for x in model['sources']}
        assert all(x['source'] in source_ids for x in inventory)
        result['processes']=spec_results
        result['software_producer_reviewer_pairs_checked']=14
        result['reference_activity_source_checks']=16
        result['advisory_dependency_graph_acyclic']=True
    text=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
    if a.output:
        a.output.parent.mkdir(parents=True,exist_ok=True); a.output.write_text(text,encoding='utf-8')
    print(text)
if __name__=='__main__':main()
