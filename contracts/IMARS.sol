// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IWrappedBNB is IERC20 { function deposit() external payable; function withdraw(uint256 amount) external; }
interface IV2Factory {
    function getPair(address a, address b) external view returns (address);
    function createPair(address a, address b) external returns (address);
}
interface IV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function mint(address to) external returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

/// V2 forbids either token address as swap recipient. This immutable receiver
/// forwards only the exact WBNB output selected by its creating IMARS contract.
contract IMARSTaxReceiver {
    using SafeERC20 for IERC20;
    address public immutable token;
    IERC20 public immutable wrapped;
    constructor(address wbnb) {token = msg.sender; wrapped = IERC20(wbnb);}
    function collect(uint256 amount) external {
        require(msg.sender == token, "Only IMARS");
        wrapped.safeTransfer(token, amount);
    }
}

/// IMARS: a finite 10,000-unit launch. An Agent ID keeps its quota across owners.
contract IMARS is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable treasury;
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant MAX_SHARES = 10_000;
    uint256 public constant FREE_SHARES = 300;
    uint256 public constant OPEN_AT = 10_000;
    uint256 public constant BASE_QUOTA = 10;
    uint256 public constant MAX_PER_TX = 10;
    uint256 public constant EARLY_TOKENS = 50_000_000 ether;
    uint256 public constant SEED_TOKENS = 350_000_000_000 ether;
    uint256 private constant SEED_WBNB = 13.58 ether;
    uint32 public constant ORACLE_WINDOW = 30 minutes;
    uint256 public constant MAX_TAX_SWAP_BPS = 25; // At most 0.25% of the token reserve per batch.
    uint256 private constant SWAP_GAS_LIMIT = 350_000;
    IERC721 public immutable idCollection;
    IWrappedBNB public immutable wrapped;
    IMARSTaxReceiver public immutable taxReceiver;
    IV2Pair public immutable pair;
    bool private immutable burnIs0;
    uint16 public constant burnBps = 5000; // of the tax, NOT of the trade
    address public earlyOpener;
    mapping(uint256 => uint256) public inviteBonus;
    mapping(uint256 => bool) public firstPaid;
    uint256 public totalMinted;
    uint256 public freeMinted; // One per distinct ID; independent of paid units.
    uint256 public pendingLiquidity;
    uint256 public pendingTreasuryTokens;
    uint256 public pendingTreasuryBNB;
    bool private settlingTreasury;
    bool public opened;
    mapping(uint256 => uint256) public mintedById;
    mapping(uint256 => bool) public freeClaimed;
    uint256 public averageRateX112;
    uint256 private observationCumulative;
    uint32 private observationTime;

    error InvalidReferral();
    error EarlyOpenUnavailable();
    error InvalidInput();
    error InvalidIdOrQuota();
    error StaleQuote();
    error IncorrectPayment();
    error TradingNotOpen();
    error ReservePriceOutsideWindow();
    error TreasurySwapUnavailable();
    error InsufficientSettlementGas();
    event FreeUnitClaimed(uint256 indexed id, uint256 indexed share, uint256 cumulative);
    event InviteCredited(uint256 indexed inviterId, uint256 indexed inviteeId, address indexed inviterWallet);
    event EarlyOpeningClosed(address indexed formerOpener, bool manual, uint256 mintedShares);
    event SharesMinted(address indexed buyer, uint256 indexed id, uint256 firstShare, uint8 quantity, uint256 cost, uint256 received);
    event PoolOpened(address indexed pair, uint256 wrappedAmount, uint256 tokenAmount);
    event TreasuryFunded(uint256 amount, bool paidInWrappedBNB);
    event TreasuryTaxAccrued(uint256 tokenAmount);
    event TreasuryTaxSwapped(uint256 tokenAmount, uint256 nativeAmount);
    event TreasuryNativePaid(uint256 amount);
    event TreasuryNativeDeferred(uint256 amount);

    constructor(address registry, address wbnb, address factory, address treasuryAddress)
        ERC20("IMARS", "IMARS")
    {
        if (registry.code.length == 0 || wbnb.code.length == 0 || factory.code.length == 0) revert InvalidInput();
        if (treasuryAddress == address(0) || treasuryAddress == DEAD || treasuryAddress == address(this)) revert InvalidInput();
        treasury = treasuryAddress;
        earlyOpener = msg.sender;
        idCollection = IERC721(registry);
        wrapped = IWrappedBNB(wbnb);
        taxReceiver = new IMARSTaxReceiver(wbnb);
        address p = IV2Factory(factory).getPair(address(this), wbnb);
        if (p == address(0)) p = IV2Factory(factory).createPair(address(this), wbnb);
        pair = IV2Pair(p);
        address t0 = IV2Pair(p).token0();
        address t1 = IV2Pair(p).token1();
        if (!((t0 == address(this) && t1 == wbnb) || (t0 == wbnb && t1 == address(this)))) revert InvalidInput();
        burnIs0 = t0 == address(this);
    }

    // Canonical WBNB withdraw uses transfer's 2,300-gas stipend. No storage writes.
    receive() external payable {
        if (msg.sender != address(wrapped)) revert InvalidInput();
    }

    /// Anyone can process a bounded batch or retry native delivery. The caller
    /// never chooses a recipient and receives no reward or protocol assets.
    function settleTreasury() external nonReentrant {
        if (!opened) revert TradingNotOpen();
        if (settlingTreasury) revert TreasurySwapUnavailable();
        _settleTreasury(100_000);
    }

    /// External-self boundary makes a failed swap/unwrap atomic and catchable.
    /// This method is not callable by users, the pair or the treasury.
    function swapTreasuryTax() external {
        if (msg.sender != address(this) || !settlingTreasury || !opened) revert TreasurySwapUnavailable();
        _guardPrice();
        _checkpoint();
        (uint256 rb, uint256 rw,) = _reserves();
        // Do not consume somebody else's pending AMM input or unsynced donation.
        if (balanceOf(address(pair)) != rb || wrapped.balanceOf(address(pair)) != rw) revert TreasurySwapUnavailable();
        uint256 amount = Math.min(pendingTreasuryTokens, Math.mulDiv(rb, MAX_TAX_SWAP_BPS, 10_000));
        if (amount == 0) revert TreasurySwapUnavailable();
        // Pancake V2's canonical factory charges 25 basis points on swap input.
        uint256 amountWithFee = amount * 9975;
        uint256 out = Math.mulDiv(amountWithFee, rw, rb * 10_000 + amountWithFee);
        if (out == 0) revert TreasurySwapUnavailable();
        uint256 minOut = Math.max(1, Math.mulDiv(out, 9950, 10_000));
        uint256 beforeWrapped = wrapped.balanceOf(address(this));
        uint256 beforeReceiver = wrapped.balanceOf(address(taxReceiver));
        pendingTreasuryTokens -= amount;
        // Only this explicit protocol sale bypasses the trading tax. Arbitrary
        // transfers during callbacks remain taxed by the ordinary _update path.
        super._update(address(this), address(pair), amount);
        pair.swap(burnIs0 ? 0 : out, burnIs0 ? out : 0, address(taxReceiver), "");
        uint256 received = wrapped.balanceOf(address(taxReceiver)) - beforeReceiver;
        if (received < minOut) revert TreasurySwapUnavailable();
        taxReceiver.collect(received);
        if (wrapped.balanceOf(address(this)) - beforeWrapped != received) revert TreasurySwapUnavailable();
        wrapped.withdraw(received);
        pendingTreasuryBNB += received;
        emit TreasuryTaxSwapped(amount, received);
    }

    function _settleTreasury(uint256 reserveGas) private {
        if (settlingTreasury) return;
        bool hasTokens = pendingTreasuryTokens != 0;
        if (!hasTokens && pendingTreasuryBNB == 0) return;
        // A successful cheap/no-op branch would make wallet gas estimators skip
        // settlement forever. Require a deterministic budget; market, pair and
        // recipient failures are caught below, unlike an undersized gas limit.
        uint256 required = reserveGas + (hasTokens ? SWAP_GAS_LIMIT + 30_000 : 75_000);
        if (gasleft() < required) revert InsufficientSettlementGas();
        settlingTreasury = true;
        if (hasTokens) {
            try this.swapTreasuryTax{gas:SWAP_GAS_LIMIT}() {} catch {}
        }
        uint256 due = pendingTreasuryBNB;
        if (due != 0) {
            pendingTreasuryBNB -= due;
            (bool ok,) = payable(treasury).call{value:due,gas:35_000}("");
            if (ok) emit TreasuryNativePaid(due);
            else {
                pendingTreasuryBNB += due;
                emit TreasuryNativeDeferred(due);
            }
        }
        settlingTreasury = false;
    }


    function priceAt(uint256 s) public pure returns (uint256) {
        if (s == 0 || s > MAX_SHARES) revert InvalidInput();
        // Paid list price. Only quoteFor can apply an individual ID discount.
        return 0.002 ether;
    }

    function _reserves() private view returns (uint256 rb, uint256 rw, uint32 ts) {
        (uint112 r0,uint112 r1,uint32 t) = pair.getReserves();
        return burnIs0 ? (r0,r1,t) : (r1,r0,t);
    }

    // Counterfactual cumulative prices, in Burn base units per WBNB base unit.
    // V2 intentionally uses modulo arithmetic for uint32 timestamps and cumulative prices.
    function _oracle() private view returns (uint256 spot, uint256 cumulative, uint32 now32) {
        (uint256 rb, uint256 rw, uint32 ts) = _reserves();
        if (rb == 0 || rw == 0) revert InvalidInput();
        now32 = uint32(block.timestamp);
        spot = (rb << 112) / rw;
        cumulative = burnIs0 ? pair.price1CumulativeLast() : pair.price0CumulativeLast();
        unchecked { cumulative += spot * (now32 - ts); }
    }

    function _guardPrice() private view {
        (uint256 spot, uint256 c, uint32 t) = _oracle();
        uint256 avg = averageRateX112;
        unchecked {
            uint32 delta = t - observationTime;
            if (delta >= ORACLE_WINDOW) avg = (c - observationCumulative) / delta;
        }
        // Do not issue tokens against a transiently distorted spot reserve price.
        uint256 diff = spot > avg ? spot - avg : avg - spot;
        if (avg == 0 || diff > avg / 20) revert ReservePriceOutsideWindow();
    }

    function _checkpoint() private {
        (, uint256 c, uint32 t) = _oracle();
        unchecked {
            uint32 delta = t - observationTime;
            if (delta >= ORACLE_WINDOW) {
                averageRateX112 = (c - observationCumulative) / delta;
                observationCumulative = c;
                observationTime = t;
            }
        }
    }

    function checkpoint() external nonReentrant {
        if (!opened) revert TradingNotOpen();
        _checkpoint();
    }

    function _checkBatch(uint256 start, uint8 quantity) private pure {
        if (quantity == 0 || quantity > MAX_PER_TX || start + quantity - 1 > MAX_SHARES) revert InvalidInput();

    }

    function _hasFree(uint256 id) private view returns (bool) {
        return freeMinted < FREE_SHARES && !freeClaimed[id];
    }

    /// The first unit of an eligible order is free; every paid unit costs 0.002 BNB.
    function quoteFor(uint256 id, uint8 quantity) external view returns (uint256 cost, uint256 tokens, uint8 freeUnits, uint8 paidUnits) {
        uint256 start = totalMinted + 1;
        _checkBatch(start, quantity);
        if (mintedById[id] + quantity > quotaOf(id)) revert InvalidIdOrQuota();
        freeUnits = _hasFree(id) ? 1 : 0;
        paidUnits = quantity - freeUnits;
        uint256 rb; uint256 rw;
        bool live = opened;
        if (live && paidUnits != 0) { _guardPrice(); (rb,rw,) = _reserves(); }
        for (uint256 i; i < quantity; ++i) {
            uint256 s = start + i;
            bool gift = i < freeUnits;
            uint256 price = gift ? 0 : priceAt(s);
            cost += price;
            if (!live) {
                tokens += EARLY_TOKENS;
                if (s == OPEN_AT) {
                    live = true;
                    rb = SEED_TOKENS;
                    rw = SEED_WBNB + wrapped.balanceOf(address(pair));
                }
            } else if (gift) {
                tokens += EARLY_TOKENS; // A gift never deposits liquidity or consumes pool reserves.
            } else {
                tokens += Math.mulDiv(price * 100, rb, rw * 99);
                uint256 lp = price * 70 / 100;
                rb += Math.mulDiv(lp,rb,rw); rw += lp;
            }
        }
    }


    function quotaOf(uint256 id) public view returns (uint256) { return BASE_QUOTA + inviteBonus[id]; }

    function mint(uint256 id, uint8 quantity, uint256 expectedStart, uint256 minTokens, uint256 deadline)
        external payable nonReentrant {
        _mintUnits(id,quantity,expectedStart,minTokens,deadline,false,0);
    }
    function mintWithInviter(uint256 id, uint8 quantity, uint256 expectedStart, uint256 minTokens, uint256 deadline, uint256 inviterId)
        external payable nonReentrant {
        _mintUnits(id,quantity,expectedStart,minTokens,deadline,true,inviterId);
    }
    function _mintUnits(uint256 id, uint8 quantity, uint256 expectedStart, uint256 minTokens, uint256 deadline, bool referred, uint256 inviterId) private {
        uint256 first = totalMinted + 1;
        if (expectedStart != first || block.timestamp > deadline) revert StaleQuote();
        _checkBatch(first,quantity);
        if (idCollection.ownerOf(id) != msg.sender || mintedById[id] + quantity > quotaOf(id)) revert InvalidIdOrQuota();
        bool gift = _hasFree(id);
        if (gift) {
            freeClaimed[id] = true;
            emit FreeUnitClaimed(id, first, ++freeMinted);
        }
        uint256 last = first + quantity - 1;
        uint256 cost;
        for (uint256 s = gift ? first + 1 : first; s <= last; ++s) cost += priceAt(s);
        if (msg.value != cost) revert IncorrectPayment();
        // Earning quota never mints a token. Only the first successful PAID mint
        // by each unique ID can credit one other ID, regardless of its owners.
        if (referred) {
            if (cost == 0 || firstPaid[id] || inviterId == id) revert InvalidReferral();
            address refOwner = idCollection.ownerOf(inviterId);
            if (refOwner == address(0) || refOwner == msg.sender) revert InvalidReferral();
            inviteBonus[inviterId] += 1;
            emit InviteCredited(inviterId, id, refOwner);
        }
        if (cost != 0 && !firstPaid[id]) firstPaid[id] = true;
        mintedById[id] += quantity;
        totalMinted = last;
        uint256 issued; uint256 allLiquidity;
        uint256 postStart = first;
        if (!opened) {
            uint256 earlyEnd = Math.min(last, OPEN_AT);
            uint256 early = earlyEnd - first + 1;
            postStart = earlyEnd + 1;
            issued = early * EARLY_TOKENS;
            uint256 lp = (early - (gift ? 1 : 0)) * 0.002 ether * 70 / 100;
            if (lp != 0) { wrapped.deposit{value:lp}(); pendingLiquidity += lp; allLiquidity += lp; }
            if (earlyEnd == OPEN_AT) _open(false);
        }
        if (postStart <= last) {
            if (!(gift && postStart == first && first == last)) { _guardPrice(); _checkpoint(); }
            for (uint256 s = postStart; s <= last; ++s) {
                if (gift && s == first) { issued += EARLY_TOKENS; continue; }
                (uint256 rb, uint256 rw,) = _reserves();
                uint256 price = priceAt(s);
                issued += Math.mulDiv(price * 100, rb, rw * 99);
                uint256 lp = price * 70 / 100;
                allLiquidity += lp;
                wrapped.deposit{value:lp}();
                _addPool(lp, Math.mulDiv(lp,rb,rw));
            }
        }
        if (issued < minTokens) revert StaleQuote();
        _mint(msg.sender,issued);
        uint256 due = cost - allLiquidity;
        if (due != 0) {
            (bool ok,) = payable(treasury).call{value:due,gas:35_000}("");
            if (!ok) { wrapped.deposit{value:due}(); IERC20(address(wrapped)).safeTransfer(treasury,due); }
            emit TreasuryFunded(due,!ok);
        }
        emit SharesMinted(msg.sender,id,first,quantity,cost,issued);
    }

    /// The sole manual action is opening the canonical pool with *all* reserved
    /// funds at the declared ratio. No configurable recipient, price, or withdrawal.
    function earlyOpenQuote() public view returns (uint256 shares, uint256 wbnbAmount, uint256 burnAmount, bool eligible) {
        shares = totalMinted;
        wbnbAmount = pendingLiquidity;
        burnAmount = Math.mulDiv(wbnbAmount, SEED_TOKENS, SEED_WBNB);
        eligible = !opened && shares < OPEN_AT && wbnbAmount > 0;
    }
    function openEarly(uint256 expectedShares, uint256 expectedWbnb, uint256 deadline) external nonReentrant {
        (uint256 shares,uint256 wbnbAmount,,bool eligible) = earlyOpenQuote();
        if (msg.sender != earlyOpener || !eligible) revert EarlyOpenUnavailable();
        if (block.timestamp > deadline || shares != expectedShares || wbnbAmount != expectedWbnb) revert StaleQuote();
        _open(true);
    }
    function _open(bool manual) private {
        uint256 lp = pendingLiquidity;
        // Before all 300 distinct IDs receive a gift, fewer than 300 IDs can
        // have minted. Their combined quota (10 per ID plus at most one referral
        // credit per paying ID) cannot reach 10,000 units.
        if (!manual) assert(freeMinted == FREE_SHARES && lp == SEED_WBNB);
        uint256 seed = Math.mulDiv(lp, SEED_TOKENS, SEED_WBNB);
        address former = earlyOpener;
        earlyOpener = address(0);
        pendingLiquidity = 0;
        opened = true;
        _addPool(lp,seed);
        (averageRateX112,observationCumulative,observationTime) = _oracle();
        emit EarlyOpeningClosed(former,manual,manual ? totalMinted : OPEN_AT);
        emit PoolOpened(address(pair),lp,seed);
    }
    function _addPool(uint256 lp, uint256 tokens) private {
        if (lp == 0 || tokens == 0) revert InvalidInput();
        _mint(address(pair),tokens);
        IERC20(address(wrapped)).safeTransfer(address(pair),lp);
        if (pair.mint(DEAD) == 0) revert InvalidInput();
    }
    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0) || amount == 0) {
            super._update(from,to,amount); return;
        }
        if (!opened) revert TradingNotOpen();
        // Before this seller supplies any input, process taxes from previous
        // trades. Never swap recursively while the pair sends a buy output.
        if (to == address(pair) && from != address(pair) && !settlingTreasury) _settleTreasury(240_000);
        if (from == address(pair) || to == address(pair)) {
            uint256 tax = Math.mulDiv(amount, 2, 100);
            uint256 burnCut = tax / 2;
            if (burnCut != 0) super._update(from,DEAD,burnCut);
            if (tax > burnCut) {
                uint256 treasuryCut = tax - burnCut;
                super._update(from,address(this),treasuryCut);
                pendingTreasuryTokens += treasuryCut;
                emit TreasuryTaxAccrued(treasuryCut);
            }
            amount -= tax;
        }
        super._update(from,to,amount);
    }
}
