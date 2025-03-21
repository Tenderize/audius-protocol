local resty_rsa = require "resty.rsa"

local utils = require "utils"

local limit_to_rps = os.getenv("audius_openresty_rps") or "1000"
local public_url = os.getenv("audius_openresty_public_url") or ""
local redirect_targets = os.getenv("audius_openresty_redirect_targets") or ""
-- local accept_redirect_from = os.getenv("audius_openresty_accept_redirect_from") or ""
local rsa_public_key = os.getenv("audius_openresty_rsa_public_key") or ""
local rsa_private_key = os.getenv("audius_openresty_rsa_private_key") or ""
local update_redirect_weights_every = os.getenv("audius_openresty_update_redirect_weights_every") or "300"

if rsa_public_key == "" or rsa_private_key == "" then
    ngx.log(ngx.WARN, "audius_openresty_rsa_private_key or audius_openresty_rsa_public_key was not set; generating new key")
    rsa_public_key, rsa_private_key, err = resty_rsa:generate_rsa_keys(2048)
    if not rsa_private_key then
        ngx.log(ngx.ERR, "Failed to generate rsa private key: ", err)
    end
end

local private_key, err = resty_rsa:new({
    private_key = rsa_private_key,
    key_type = resty_rsa.KEY_TYPE.PKCS1,
    algorithm = "sha1",
})

if not private_key then
    ngx.log(ngx.ERR, "Failed to load private key: ", err)
end

local _M = {}
_M.limit_to_rps = tonumber(limit_to_rps)
_M.public_url = public_url
_M.redirect_targets = utils.split_on_comma(redirect_targets)
-- _M.accept_redirect_from = utils.toset(utils.split_on_comma(accept_redirect_from))
_M.rsa_public_key = rsa_public_key
_M.rsa_private_key = rsa_private_key
_M.private_key = private_key
-- Disable rate limiting if there are no redirect targets or public_url is not set
_M.rate_limiting_enabled = #redirect_targets ~= 0 or public_url == ""
_M.update_redirect_weights_every = tonumber(update_redirect_weights_every)
return _M
