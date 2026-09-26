"""The production backend for apricity-prune: DynamoDB tables and the S3 bucket behind the Amplify app,
with the names found from https://apricity.anth.us/amplify_outputs.json. Needs boto3 and AWS access."""
from __future__ import annotations

import json
import urllib.request

OUTPUTS = "https://apricity.anth.us/amplify_outputs.json"


class AwsBackend:
    def __init__(self, region: str = "us-east-1"):
        import boto3
        from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

        self.out = json.loads(urllib.request.urlopen(OUTPUTS).read())
        self.region = region
        self.ddb = boto3.client("dynamodb", region_name=region)
        self.s3 = boto3.client("s3", region_name=region)
        self.idp = boto3.client("cognito-idp", region_name=region)
        self._de, self._se = TypeDeserializer(), TypeSerializer()
        tables = [t for p in self.ddb.get_paginator("list_tables").paginate() for t in p["TableNames"]]
        suffix = next((t.split("-", 1)[1] for t in tables if t.startswith("Sample-") and t.endswith("-NONE")), None)
        if not suffix:
            raise SystemExit("cannot find the Sample table")
        self.suffix = suffix
        self.bucket = self.out["storage"]["bucket_name"]

    def table(self, model: str) -> str:
        return f"{model}-{self.suffix}"

    def curator_subs(self) -> set[str]:
        pool = self.out["auth"]["user_pool_id"]
        subs = set()
        for page in self.idp.get_paginator("list_users_in_group").paginate(UserPoolId=pool, GroupName="curators"):
            for u in page["Users"]:
                subs |= {a["Value"] for a in u["Attributes"] if a["Name"] == "sub"}
        return subs

    def scan(self, model: str) -> list[dict]:
        rows = []
        for page in self.ddb.get_paginator("scan").paginate(TableName=self.table(model)):
            rows += [{k: self._de.deserialize(v) for k, v in item.items()} for item in page["Items"]]
        return _plain(rows)

    def delete_row(self, model: str, key: dict) -> None:
        self.ddb.delete_item(TableName=self.table(model), Key={k: self._se.serialize(v) for k, v in key.items()})

    def delete_object(self, key: str) -> None:
        self.s3.delete_object(Bucket=self.bucket, Key=key)


def _plain(x):
    """DynamoDB numbers come back as Decimal: make them ints or floats."""
    from decimal import Decimal

    if isinstance(x, Decimal):
        return int(x) if x == x.to_integral_value() else float(x)
    if isinstance(x, list):
        return [_plain(i) for i in x]
    if isinstance(x, dict):
        return {k: _plain(v) for k, v in x.items()}
    return x
