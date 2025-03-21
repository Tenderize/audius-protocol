import logging

import requests
from flask import Blueprint
from src.api_helpers import success_response
from src.utils.get_all_other_nodes import get_all_other_nodes

logger = logging.getLogger(__name__)

bp = Blueprint("redirect_weights", __name__)


@bp.route("/redirect_weights", methods=["GET"])
def redirect_weights():
    endpoints, _ = get_all_other_nodes()
    loads = {}
    for endpoint in endpoints:
        response = requests.get(f"{endpoint}/request_count")
        if response.status_code == 200:
            loads[endpoint] = int(response.text)

    if len(loads) == 0:
        loads = {endpoint: 1 for endpoint in endpoints}

    max_load = max(loads.values(), default=1)
    redirect_weights = {}
    for endpoint, load in loads.items():
        redirect_weights[endpoint] = (max_load - load) + 5

    return success_response(redirect_weights, sign_response=False)
