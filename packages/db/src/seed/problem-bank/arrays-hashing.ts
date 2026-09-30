import type { SeedProblem } from './types.js';

/**
 * Arrays, strings and hashing.
 *
 * Original problems written for this bank. Expected outputs come from the
 * reference solutions and are re-checked by problem-bank.test.ts.
 */
export const ARRAYS_HASHING: SeedProblem[] = [
  {
    key: 'pair-sum-indices',
    revision: 2,
    title: 'Pair sum indices',
    difficulty: 'EASY',
    tags: ['arrays', 'hashing'],
    companyTags: ['product-company', 'service-company'],
    statement: [
      'You are given a list of integers and a target. Exactly one pair of different positions adds up to the target. Print the two positions (0-based), smaller first.',
      'Input: the first line has `n` (2 ≤ n ≤ 10 000) and `target`. The second line has `n` integers, each between -1 000 000 and 1 000 000.',
      'Output: two indices `i j` with `i < j`.',
      'Aim for better than checking every pair.',
    ],
    visibleTests: [
      { input: '4 9\n2 7 11 15\n', expectedOutput: '0 1\n', explanation: '2 + 7 = 9' },
      { input: '3 6\n3 2 4\n', expectedOutput: '1 2\n', explanation: null },
    ],
    hiddenTests: [
      ['2 6\n3 3\n', '0 1\n'],
      ['5 10\n1 2 3 4 6\n', '3 4\n'],
      ['6 0\n-3 4 2 -2 5 1\n', '2 3\n'],
      ['4 100\n50 1 2 50\n', '0 3\n'],
      ['2 -2000000\n-1000000 -1000000\n', '0 1\n'],
      ['5 0\n0 7 -8 0 9\n', '0 3\n'],
      [
        '40 19\n-6 -7 -8 36 -33 13 12 18 42 -41 40 29 -45 2 46 35 -6 -50 -2 -39 9 19 31 -47 17 -4 40 -49 -36 3 3 -32 -19 44 -30 31 -2 37 -29 -9\n',
        '13 24\n',
      ],
      [
        '200 1154\n-484 293 363 -188 -209 911 391 -716 -901 -678 460 -758 783 -914 -604 -415 -270 497 102 641 -754 -172 -325 852 -946 705 111 752 -11 -650 -236 -863 -367 -102 639 781 717 330 -419 -542 -198 478 265 -165 567 -710 180 -203 382 421 -557 118 -422 638 774 -700 -95 -642 707 -781 139 911 836 -486 803 -1 -114 -754 -689 -338 811 -961 -447 159 164 -706 -440 280 -181 -439 -341 -534 -835 -13 -589 -251 129 -469 144 -896 -690 -869 -986 828 557 -367 372 -840 -992 -627 -312 -10 -714 615 -586 776 -164 -9 -935 -151 -281 652 146 -190 141 -882 -560 127 263 345 693 275 -484 -433 -614 922 -405 770 -489 648 -93 169 707 926 484 -904 -640 755 -946 934 -655 103 -757 382 -848 -445 -265 -951 543 138 -366 -872 53 -46 -979 815 -570 -870 964 -254 -978 570 79 -458 659 -499 622 893 506 13 -183 -370 644 88 695 363 572 643 572 -794 917 946 -13 -177 720 444 -164 -487 841 862 277 -952 -981 181 -712 -535 -338 -205 483 -244\n',
        '129 168\n',
      ],
      [
        '600 133808\n-54786 -78122 15479 79657 97016 -63295 -953 98422 17356 77520 14525 -69073 16654 -16136 92594 90761 -81270 -69628 -6697 74652 43685 86639 -70316 84284 -68965 4115 -18721 81124 71119 46853 -70148 -44649 -74572 8742 -15028 40595 -63304 -67662 -59349 -28165 23835 6850 -91775 13230 -1034 -47495 76780 84262 29611 29400 14489 80765 1711 34091 26279 -72416 44059 94600 -56351 53569 -15047 -47015 -96138 -9229 -57047 70759 -8316 -1171 55033 36307 79238 1857 18696 50541 54352 21183 -6084 53045 -61247 25953 84506 3898 -14012 -76300 82825 28321 -38768 65775 -31512 -8019 91472 7693 50727 -88172 -32615 -83177 -33205 -1022 -36239 87820 -44072 13437 61908 -82897 46677 -52890 8465 39202 19480 1377 27612 -69187 -39361 -51183 97427 62514 -73182 78109 -19640 31234 -60609 -90807 83100 -7741 48917 -58167 44573 28508 -12697 28339 -60271 17101 -6469 -20768 -74394 -35236 -59057 -42725 -47765 40239 93353 59863 -9778 -68332 -57244 -50164 52684 -55855 -3349 80690 -14946 -4575 -71443 88367 -23747 59439 90546 -30606 -71053 -34675 -6149 -94671 -54782 40826 -33530 75051 -23183 -24903 -33713 47008 -65514 -31157 27105 -80142 -28536 -92398 -25277 -27233 33485 -60109 2147 -58030 42719 -65685 59749 -76582 42550 92391 -57332 40130 96708 73002 84216 54465 67366 -31881 -19669 -85758 11967 -4926 70871 42222 -38809 26095 18707 79884 -2882 -9393 91163 -43334 67790 32551 -29032 48378 90482 -8575 -39134 -80246 44155 -71097 50692 72266 94714 -81181 -20747 -99299 -73260 48224 -68616 -48804 -3683 -18914 -7302 -63079 -83896 74681 74266 -82207 -63109 -92222 8342 49664 -62520 79604 36626 42170 -79765 14497 38149 78114 -51616 -77440 38072 82088 -7140 60569 30808 -48223 84825 -73330 9386 -63428 27374 -49433 -79371 81793 27651 -92256 46164 47181 -76657 -64639 -21301 -32875 -12017 -42483 84047 -28565 -60381 41877 -59438 12108 -94709 59629 28369 54835 79757 49793 60626 60731 -17105 -55561 -77351 36117 -58810 -91652 -71386 -70709 -21903 -21149 -93693 8580 -91622 -60910 -51141 80479 58519 36253 52063 98541 75859 -78228 -99822 -2685 -82199 -43330 3657 -39174 6856 -8099 -12040 -42506 -9105 2752 -96081 -36608 -31250 -87466 53521 -3088 37917 89497 -12082 36614 76921 -7753 19249 70804 -38557 8579 -53941 -47360 -60688 -44574 -33566 18320 25566 -42082 -12737 -51550 -37544 77759 71534 59971 -31779 56111 37037 50539 -33173 50309 -94142 -51629 -18515 -39126 -82757 -20966 33618 -13602 93821 90432 -46424 76718 -90969 -35020 41579 -75729 -79403 79496 32026 -35921 15765 -42896 -88225 8622 46045 -63810 -2815 75572 -6557 -81678 -80822 1494 -64465 9865 75758 -39049 -11355 -45755 -524 -24748 47388 55529 94380 -82130 24742 -96373 -86362 30802 -91375 -281 -82933 11372 -58451 -62391 -82268 -46107 -58099 29190 -40726 -16522 -10370 -63679 -64279 -62840 87308 -16255 -88783 -49495 -37793 -64428 83930 77789 -37877 90439 75190 18947 -3701 -2401 90529 -68506 -28434 -61612 -81217 -51547 90173 -8898 77300 -87090 -67722 -19533 -15780 -52070 52688 -67814 -28203 38124 36832 41641 48820 15987 99826 38081 -31366 -75848 -78640 71331 -41558 -95671 -79896 -18891 99407 77496 32066 -51255 -57970 -13384 67300 49012 -72519 -22818 26783 56675 20521 -8172 58100 28046 21908 -89774 -49986 -61364 22969 77859 -93596 15055 99937 53201 4997 42438 -86398 -26139 -57315 -88073 -54641 5170 93039 -44532 -94860 -93644 -42398 11167 30856 60483 71127 -83448 21921 -93545 -52142 -10343 -96020 -56398 -20227 -89110 -11762 -31691 62203 47305 -3171 80286 23976 -34267 63554 94738 -16874 -56390 -6527 -62339 51866 52298 60528 9304 12622 41589 53848 20675 -32791 -12855 28843 -38831 77644 63020 72507 -57372 22778 33392 47171 -24332 -55184 89633 -17813 -38366 45476 52995 5818 -58683 84042 -10940 -25540 67489 -74590 66161 80172 -99161 -9009 25690 46625 -70621 30344 95359 34795 70550 -663 79730 -99569 73735 30154 5094 -29464 30479 50524 65645 49072 21177 -85226 -76424 -16246 30417 67558 26298 -83814 68112\n',
        '27 146\n',
      ],
    ],
    reference:
      'import sys\n\n\ndef main():\n    data = sys.stdin.read().split()\n    n, target = int(data[0]), int(data[1])\n    values = list(map(int, data[2:2 + n]))\n    first_seen = {}\n    for j, x in enumerate(values):\n        if target - x in first_seen:\n            print(first_seen[target - x], j)\n            return\n        first_seen.setdefault(x, j)\n\n\nmain()\n',
  },
  {
    key: 'running-balance-dips',
    revision: 1,
    title: 'Running balance dips',
    difficulty: 'EASY',
    tags: ['arrays', 'prefix-sum'],
    companyTags: ['fintech'],
    statement: [
      'A wallet starts with a balance of 0. Transactions arrive in order: a positive amount is money in, a negative amount is money out. After each transaction the balance changes by that amount.',
      'Count how many times the balance goes from zero or more to below zero, and find the lowest balance ever reached (the starting 0 counts, so the lowest balance is never above 0).',
      'Input: the first line has `n` (1 ≤ n ≤ 100 000). The second line has `n` non-zero integers, each between -1 000 000 and 1 000 000.',
      'Output: two integers, the number of dips and the lowest balance, separated by a space.',
    ],
    visibleTests: [
      {
        input: '5\n100 -150 80 -40 -20\n',
        expectedOutput: '2 -50\n',
        explanation:
          'The balance goes 100, -50, 30, -10, -30: it drops below zero twice and the lowest is -50.',
      },
      {
        input: '3\n5 5 5\n',
        expectedOutput: '0 0\n',
        explanation: 'It never drops below zero, so the lowest balance is the starting 0.',
      },
    ],
    hiddenTests: [
      ['1\n-7\n', '1 -7\n'],
      ['1\n7\n', '0 0\n'],
      ['4\n-1 1 -1 1\n', '2 -1\n'],
      ['2\n-1000000 -1000000\n', '1 -2000000\n'],
      ['6\n10 -10 -1 1 1 -1\n', '1 -1\n'],
      ['3\n-5 10 -5\n', '1 -5\n'],
      [
        '50\n35 19 2 62 83 89 -72 -85 -57 21 27 -74 -10 88 12 -8 -12 57 -85 18 80 -90 -72 -65 -52 86 62 70 -83 -25 46 89 87 15 31 47 66 -4 56 -67 -29 6 27 -97 -23 -90 5 36 45 -66\n',
        '1 -89\n',
      ],
      [
        '400\n386197 -356159 477764 730803 251567 -487303 190738 -803669 -956346 -993734 959922 188262 -833562 -525763 -259581 -378486 -25071 924809 670472 -240664 513538 275438 937761 -470598 646850 -291824 989755 738928 -769663 546288 29903 -727822 -138131 440741 -252950 -456424 61644 797374 -437944 617020 -944727 827571 -608346 386369 590692 -17944 -947710 -836482 -941073 -954740 560919 -827449 830902 -744787 198116 283847 652328 -222209 608891 -75217 373041 86356 148698 -755727 325683 -796527 383365 -31185 -511520 508949 -59419 479153 -927242 101582 -8100 384287 890016 -721920 310435 -541486 -525373 170233 407743 -482525 823593 -872070 -427336 546738 695493 -111482 367242 -337919 939208 663261 178632 -500245 -839801 -264085 48141 842644 299506 981608 407978 155394 -271897 -883622 432458 647814 356351 806016 516375 985546 854292 -178077 -876345 114980 548145 -910576 770335 808251 -900679 873503 -785387 -582600 44638 -849653 -204908 -206446 972013 -193002 572696 -636343 -382337 562295 -470237 -553198 -683144 -839604 529826 666422 489991 664867 894271 936117 -749745 21534 -515424 723935 -884249 575426 637200 790491 -879808 -365340 -242957 -443612 -844997 -877552 -978359 -32492 -719955 -622002 -615590 659783 -483326 444123 838971 -409739 -687894 999028 -835571 149025 128406 629271 -701605 13150 -239633 -505857 766508 865918 794086 356197 802422 359182 -932629 67471 -357940 279466 -879207 781130 264378 438806 -125052 181219 574691 -624799 396776 324889 372082 989347 74630 -655031 932545 -986029 650678 645918 900070 -311290 348527 44921 678998 -875512 -907605 171633 95073 179933 239647 70442 -196826 -287256 -668136 -618396 -502104 480718 -982538 410770 487962 376865 749858 -250809 525928 372535 321464 -25855 -933587 409238 946284 158866 605199 187983 443171 871343 -149100 -475036 -556954 257590 -221030 -817148 537038 322403 -978301 -153206 -398394 977060 823508 -131967 -802512 -829836 -273387 -559656 113859 647356 -878465 -457135 22551 402732 882437 89111 -572867 588966 570427 -888206 435164 -25536 834794 -553384 326773 -314155 293475 549691 -814783 -911388 681759 726033 363463 -685970 -865237 -120392 -67140 -140621 -185650 234215 20453 -296229 596967 735167 788054 -863983 787392 -299277 792243 216106 -21722 375341 98579 389974 372915 42059 564967 -313197 146083 -962747 250854 -927376 -91638 -639239 -779068 859004 280583 -458497 -955716 332016 54000 692359 945225 -902079 -651237 -866268 -701264 517502 -539344 -706236 559790 740607 200328 -619038 -555880 752055 161794 -211466 223683 -268808 -343959 968110 541719 -454980 952280 -177096 -681678 -88237 -758409 656536 -45440 -494774 777486 -166955 -899178 638355 -155844 831771 -937011 541658 -550104 262302 -411960 -575025 960298 -447229 -472514 -209774 805646 -704854 -704983 -8705 -769907 -422693 585325 -93276 682762 -535390 -831653 72423 -960422 26712 11192 -112651 -10497 796657 275912 756216 124649 -459943 -921337 863740 389707 958345 114031 -343643 241484 928458\n',
        '6 -2434421\n',
      ],
      [
        '1000\n2 2 2 2 -3 -3 -3 2 -3 -3 -3 2 2 2 2 -3 -3 -3 2 -3 2 2 2 -3 -3 -3 -3 2 2 2 2 -3 -3 -3 2 -3 -3 2 2 -3 2 2 2 2 -3 2 2 2 -3 -3 2 2 -3 2 -3 -3 2 -3 -3 -3 -3 2 -3 -3 -3 -3 2 -3 2 -3 -3 2 -3 -3 -3 2 2 -3 -3 -3 2 2 2 -3 -3 -3 2 2 -3 -3 -3 2 -3 -3 -3 2 -3 2 -3 2 2 -3 2 -3 -3 2 -3 -3 2 2 2 2 2 2 -3 2 2 -3 -3 -3 2 2 -3 -3 2 2 -3 -3 -3 -3 -3 -3 2 2 -3 2 2 -3 -3 2 2 2 -3 2 -3 -3 -3 -3 2 2 2 2 2 2 2 -3 -3 -3 -3 -3 -3 -3 -3 -3 -3 2 2 2 -3 2 2 -3 -3 2 -3 -3 2 -3 2 2 2 -3 2 -3 2 -3 -3 -3 -3 2 2 -3 -3 -3 -3 -3 -3 2 2 2 -3 2 2 2 -3 -3 -3 2 2 2 -3 2 2 -3 -3 -3 2 -3 -3 -3 2 -3 2 2 -3 -3 -3 -3 2 2 -3 2 -3 -3 -3 2 2 -3 -3 2 2 -3 -3 2 2 2 2 -3 2 2 -3 -3 2 2 -3 2 2 -3 -3 -3 -3 -3 -3 2 -3 2 -3 -3 2 2 2 -3 -3 2 2 -3 2 -3 -3 -3 2 2 2 2 2 2 -3 2 -3 -3 -3 -3 2 -3 -3 -3 2 2 -3 2 2 -3 2 -3 2 2 2 2 2 2 2 2 2 2 -3 2 -3 2 2 -3 2 -3 2 2 -3 -3 2 -3 2 -3 -3 2 2 2 -3 -3 -3 2 2 2 -3 -3 2 2 2 2 2 -3 -3 2 -3 -3 2 -3 2 2 -3 -3 2 2 2 2 -3 -3 -3 2 2 2 2 -3 2 2 2 -3 -3 -3 -3 2 -3 -3 -3 -3 -3 2 -3 2 -3 2 -3 2 2 -3 -3 2 2 -3 -3 2 2 2 2 -3 2 2 2 2 -3 -3 2 2 2 2 -3 2 2 -3 -3 2 -3 -3 2 2 -3 -3 2 -3 -3 2 -3 -3 -3 2 2 -3 -3 2 2 2 -3 -3 2 2 -3 2 2 -3 2 2 -3 2 -3 2 2 -3 -3 2 -3 2 2 2 -3 2 -3 2 2 2 -3 2 2 2 -3 2 -3 2 -3 -3 -3 2 2 -3 -3 2 -3 2 -3 2 -3 -3 2 -3 2 2 2 2 2 -3 2 -3 -3 -3 -3 -3 2 2 -3 -3 2 2 2 -3 -3 2 2 2 2 2 -3 -3 2 -3 -3 2 2 -3 -3 2 -3 -3 2 -3 2 -3 -3 -3 -3 2 2 2 2 2 2 -3 2 -3 -3 -3 -3 -3 2 2 2 2 -3 2 -3 -3 2 2 -3 2 2 2 -3 -3 2 2 -3 -3 2 2 -3 -3 -3 2 2 -3 2 -3 -3 -3 2 2 2 2 -3 -3 -3 2 2 -3 -3 2 -3 -3 2 2 2 -3 2 -3 -3 2 -3 -3 -3 2 -3 2 2 2 -3 2 2 -3 2 -3 -3 2 -3 -3 2 -3 2 2 2 -3 2 -3 2 2 -3 2 -3 -3 2 -3 -3 -3 2 -3 2 -3 -3 2 2 -3 -3 2 -3 -3 -3 -3 -3 2 -3 -3 -3 2 -3 2 -3 2 -3 -3 -3 2 2 -3 -3 -3 -3 2 2 2 2 -3 -3 -3 -3 -3 2 -3 2 -3 2 -3 -3 2 2 -3 2 -3 -3 2 2 2 2 -3 2 -3 -3 2 2 2 -3 -3 2 -3 -3 -3 2 2 2 -3 -3 -3 -3 -3 2 2 2 2 2 -3 -3 -3 -3 2 2 -3 -3 -3 -3 2 2 2 2 2 2 2 -3 2 -3 2 2 2 -3 2 2 -3 2 -3 -3 -3 -3 -3 -3 -3 -3 -3 2 2 -3 2 -3 -3 2 2 -3 -3 2 -3 2 -3 2 -3 -3 -3 2 2 2 -3 2 2 2 -3 2 -3 2 -3 -3 -3 2 -3 -3 -3 2 2 2 -3 -3 2 -3 2 2 2 -3 2 2 2 2 2 2 -3 -3 2 2 -3 2 2 -3 2 -3 2 2 2 2 -3 2 -3 2 2 2 -3 -3 2 -3 -3 2 -3 -3 -3 -3 2 2 2 -3 -3 -3 -3 -3 2 -3 2 2 2 2 2 -3 2 -3 -3 2 -3 -3 2 2 2 -3 -3 -3 2 -3 -3 2 -3 2 2 2 -3 -3 2 -3 -3 -3 2 -3 -3 2 -3 -3 -3 2 2 2 -3 -3 2 -3 -3 2 -3 -3 -3 -3 2 -3 -3 -3 2 2 -3 -3 2 2 2 2 2 -3 -3 2 -3 2 2 2 -3 2 2 2 2 -3 2 -3 2 -3 -3 -3 -3 -3 -3 -3 -3 2 2 -3 -3 2 2 -3 -3 -3 2 -3 2 2 -3 -3 -3 -3 2 -3 -3 2 2 -3 -3 2 -3 -3 -3 -3 -3 2 -3 -3 2 2 -3 -3 2 2 2 2 -3 2 -3 -3 -3 -3 -3 2 -3 2 2 2 -3 -3 2 2 -3\n',
        '3 -546\n',
      ],
    ],
    reference:
      'import sys\n\n\ndef main():\n    data = sys.stdin.read().split()\n    n = int(data[0])\n    balance = lowest = dips = 0\n    for amount in map(int, data[1:1 + n]):\n        before = balance\n        balance += amount\n        if before >= 0 and balance < 0:\n            dips += 1\n        lowest = min(lowest, balance)\n    print(dips, lowest)\n\n\nmain()\n',
  },
  {
    key: 'first-unique-order-id',
    revision: 1,
    title: 'First order id seen once',
    difficulty: 'EASY',
    tags: ['hashing', 'strings'],
    companyTags: ['e-commerce'],
    statement: [
      'A checkout service logs order ids as it processes them; a retried order is logged again with the same id. Find the first id in the log that appears exactly once in the whole log.',
      'Input: the first line has `n` (1 ≤ n ≤ 100 000). The second line has `n` ids separated by spaces; each id is 1 to 12 lower-case letters or digits.',
      'Output: the first id that appears exactly once, or `NONE` if every id appears more than once.',
    ],
    visibleTests: [
      {
        input: '6\na17 b22 a17 c9 b22 d4\n',
        expectedOutput: 'c9\n',
        explanation: '`a17` and `b22` appear twice; `c9` is the first id seen once.',
      },
      { input: '4\nx x y y\n', expectedOutput: 'NONE\n', explanation: null },
    ],
    hiddenTests: [
      ['1\nsolo\n', 'solo\n'],
      ['2\naa aa\n', 'NONE\n'],
      ['3\nk1 k2 k1\n', 'k2\n'],
      ['5\nz y x y z\n', 'x\n'],
      ['6\n1 2 3 1 2 3\n', 'NONE\n'],
      ['7\nabc ab abc a ab abc a\n', 'NONE\n'],
      [
        '300\nord336 ord957 ord921 ord801 ord800 ord229 ord229 ord723 ord229 ord336 ord957 ord851 ord130 ord756 ord921 ord229 ord723 ord336 ord990 ord800 ord767 ord291 ord723 ord541 ord172 ord644 ord756 ord862 ord990 ord723 ord756 ord319 ord250 ord319 ord800 ord990 ord957 ord966 ord229 ord319 ord336 ord401 ord851 ord172 ord966 ord130 ord921 ord851 ord862 ord130 ord851 ord172 ord969 ord782 ord290 ord969 ord233 ord990 ord336 ord990 ord851 ord336 ord966 ord336 ord330 ord723 ord921 ord644 ord291 ord172 ord767 ord644 ord767 ord723 ord290 ord401 ord990 ord921 ord801 ord756 ord319 ord319 ord851 ord330 ord365 ord130 ord756 ord114 ord800 ord397 ord767 ord921 ord291 ord229 ord401 ord957 ord851 ord319 ord336 ord969 ord130 ord756 ord130 ord800 ord336 ord723 ord541 ord229 ord990 ord290 ord401 ord800 ord319 ord990 ord233 ord401 ord862 ord921 ord723 ord401 ord966 ord767 ord130 ord291 ord290 ord800 ord966 ord397 ord644 ord401 ord644 ord397 ord990 ord644 ord130 ord644 ord250 ord969 ord782 ord290 ord969 ord229 ord862 ord172 ord800 ord723 ord767 ord969 ord801 ord756 ord319 ord966 ord172 ord229 ord172 ord401 ord397 ord851 ord957 ord250 ord319 ord801 ord233 ord365 ord921 ord782 ord800 ord756 ord782 ord114 ord336 ord644 ord966 ord401 ord801 ord291 ord233 ord990 ord800 ord957 ord397 ord365 ord250 ord250 ord921 ord291 ord172 ord172 ord233 ord957 ord291 ord767 ord862 ord290 ord782 ord229 ord397 ord330 ord233 ord401 ord114 ord969 ord130 ord921 ord336 ord756 ord862 ord957 ord800 ord290 ord336 ord756 ord644 ord767 ord990 ord541 ord767 ord644 ord782 ord756 ord290 ord319 ord990 ord756 ord397 ord250 ord330 ord851 ord801 ord801 ord541 ord397 ord966 ord114 ord365 ord319 ord541 ord782 ord290 ord851 ord291 ord172 ord330 ord250 ord397 ord782 ord233 ord756 ord921 ord921 ord800 ord397 ord800 ord990 ord957 ord969 ord290 ord782 ord782 ord966 ord330 ord782 ord397 ord990 ord921 ord800 ord990 ord291 ord851 ord644 ord723 ord644 ord756 ord397 ord990 ord172 ord782 ord921 ord229 ord397 ord250 ord969 ord723 ord723 ord172 ord130 ord921 ord723 ord365 ord723 ord767 ord114 ord800 ord862 ord921 ord801 ord291 ord114 ord990 ord801\n',
        'NONE\n',
      ],
      [
        '301\nord990 ord336 ord229 ord957 ord290 ord397 ord401 ord767 ord862 ord957 ord114 ord767 ord233 ord229 ord114 ord541 ord851 ord290 ord644 ord330 ord966 ord397 ord957 ord172 ord723 ord397 ord800 ord966 ord921 ord172 ord541 ord229 ord990 ord172 ord330 ord782 ord921 ord172 ord782 ord336 ord801 ord990 ord397 ord114 ord365 ord969 ord130 ord365 ord800 ord233 ord401 ord336 ord800 ord801 ord250 ord229 ord319 ord756 ord969 ord966 ord957 ord862 ord401 ord401 ord782 ord114 ord541 ord397 ord800 ord800 ord782 ord330 ord330 ord291 ord330 ord336 ord921 ord229 ord921 ord851 ord782 ord365 ord233 ord365 ord172 ord336 ord336 ord250 ord767 ord114 ord767 ord800 ord800 ord990 ord756 ord969 ord957 ord541 ord229 ord291 ord756 ord336 ord921 ord851 ord644 ord723 ord172 ord851 ord290 ord541 ord330 ord401 ord291 ord957 ord290 ord365 ord644 ord723 ord397 ord291 ord957 ord233 ord969 ord921 ord800 ord365 ord644 ord921 ord782 ord801 ord723 ord723 ord291 ord644 ord233 ord130 ord957 ord397 ord290 ord401 ord130 ord114 ord319 ord401 ord756 ord365 ord172 ord365 ord541 ord800 ord862 ord921 ord782 ord957 ord966 ord921 ord319 ord397 ord130 ord233 ord756 ord114 ord541 ord336 ord767 ord291 ord365 ord966 ord800 ord767 ord250 ord233 ord233 ord365 ord644 ord851 ord723 ord541 ord114 ord250 ord319 ord767 ord966 ord397 ord233 ord401 ord756 ord767 ord114 ord233 ord130 ord365 ord800 ord990 ord114 ord921 ord114 ord851 ord957 ord990 ord957 ord921 ord862 ord990 ord130 ord767 ord862 ord782 ord644 ord801 ord336 ord401 ord921 ord921 ord130 ord969 ord966 ord800 ord397 ord172 ord319 ord921 ord966 ord130 ord233 ord365 ord541 ord851 ord723 ord990 ord330 ord644 ord957 ord644 ord291 ord229 ord644 ord233 ord756 ord801 ord114 ord800 ord851 ord233 ord336 ord250 ord330 ord862 ord800 ord114 ord290 ord862 ord250 ord330 ord644 ord801 ord541 ord291 ord114 ord756 ord782 ord957 ord114 ord229 ord365 ord401 ord851 ord330 ord756 ord291 ord644 ord723 ord130 ord397 ord801 ord336 ord290 ord365 ord921 ord172 ord250 ord782 ord957 ord233 ord290 ord756 ord114 ord172 ord782 ord365 ord290 ord319 ord723 ord801 ord130 ord800 ord319 ord921 ord801 ord172 ord0001\n',
        'ord0001\n',
      ],
      [
        '2000\nq0 q1 q2 q3 q4 q5 q6 q7 q8 q9 q10 q11 q12 q13 q14 q15 q16 q17 q18 q19 q20 q21 q22 q23 q24 q25 q26 q27 q28 q29 q30 q31 q32 q33 q34 q35 q36 q37 q38 q39 q40 q41 q42 q43 q44 q45 q46 q47 q48 q49 q50 q51 q52 q53 q54 q55 q56 q57 q58 q59 q60 q61 q62 q63 q64 q65 q66 q67 q68 q69 q70 q71 q72 q73 q74 q75 q76 q77 q78 q79 q80 q81 q82 q83 q84 q85 q86 q87 q88 q89 q90 q91 q92 q93 q94 q95 q96 q97 q98 q99 q100 q101 q102 q103 q104 q105 q106 q107 q108 q109 q110 q111 q112 q113 q114 q115 q116 q117 q118 q119 q120 q121 q122 q123 q124 q125 q126 q127 q128 q129 q130 q131 q132 q133 q134 q135 q136 q137 q138 q139 q140 q141 q142 q143 q144 q145 q146 q147 q148 q149 q150 q151 q152 q153 q154 q155 q156 q157 q158 q159 q160 q161 q162 q163 q164 q165 q166 q167 q168 q169 q170 q171 q172 q173 q174 q175 q176 q177 q178 q179 q180 q181 q182 q183 q184 q185 q186 q187 q188 q189 q190 q191 q192 q193 q194 q195 q196 q197 q198 q199 q200 q201 q202 q203 q204 q205 q206 q207 q208 q209 q210 q211 q212 q213 q214 q215 q216 q217 q218 q219 q220 q221 q222 q223 q224 q225 q226 q227 q228 q229 q230 q231 q232 q233 q234 q235 q236 q237 q238 q239 q240 q241 q242 q243 q244 q245 q246 q247 q248 q249 q250 q251 q252 q253 q254 q255 q256 q257 q258 q259 q260 q261 q262 q263 q264 q265 q266 q267 q268 q269 q270 q271 q272 q273 q274 q275 q276 q277 q278 q279 q280 q281 q282 q283 q284 q285 q286 q287 q288 q289 q290 q291 q292 q293 q294 q295 q296 q297 q298 q299 q300 q301 q302 q303 q304 q305 q306 q307 q308 q309 q310 q311 q312 q313 q314 q315 q316 q317 q318 q319 q320 q321 q322 q323 q324 q325 q326 q327 q328 q329 q330 q331 q332 q333 q334 q335 q336 q337 q338 q339 q340 q341 q342 q343 q344 q345 q346 q347 q348 q349 q350 q351 q352 q353 q354 q355 q356 q357 q358 q359 q360 q361 q362 q363 q364 q365 q366 q367 q368 q369 q370 q371 q372 q373 q374 q375 q376 q377 q378 q379 q380 q381 q382 q383 q384 q385 q386 q387 q388 q389 q390 q391 q392 q393 q394 q395 q396 q397 q398 q399 q400 q401 q402 q403 q404 q405 q406 q407 q408 q409 q410 q411 q412 q413 q414 q415 q416 q417 q418 q419 q420 q421 q422 q423 q424 q425 q426 q427 q428 q429 q430 q431 q432 q433 q434 q435 q436 q437 q438 q439 q440 q441 q442 q443 q444 q445 q446 q447 q448 q449 q450 q451 q452 q453 q454 q455 q456 q457 q458 q459 q460 q461 q462 q463 q464 q465 q466 q467 q468 q469 q470 q471 q472 q473 q474 q475 q476 q477 q478 q479 q480 q481 q482 q483 q484 q485 q486 q487 q488 q489 q490 q491 q492 q493 q494 q495 q496 q497 q498 q499 q500 q501 q502 q503 q504 q505 q506 q507 q508 q509 q510 q511 q512 q513 q514 q515 q516 q517 q518 q519 q520 q521 q522 q523 q524 q525 q526 q527 q528 q529 q530 q531 q532 q533 q534 q535 q536 q537 q538 q539 q540 q541 q542 q543 q544 q545 q546 q547 q548 q549 q550 q551 q552 q553 q554 q555 q556 q557 q558 q559 q560 q561 q562 q563 q564 q565 q566 q567 q568 q569 q570 q571 q572 q573 q574 q575 q576 q577 q578 q579 q580 q581 q582 q583 q584 q585 q586 q587 q588 q589 q590 q591 q592 q593 q594 q595 q596 q597 q598 q599 q600 q601 q602 q603 q604 q605 q606 q607 q608 q609 q610 q611 q612 q613 q614 q615 q616 q617 q618 q619 q620 q621 q622 q623 q624 q625 q626 q627 q628 q629 q630 q631 q632 q633 q634 q635 q636 q637 q638 q639 q640 q641 q642 q643 q644 q645 q646 q647 q648 q649 q650 q651 q652 q653 q654 q655 q656 q657 q658 q659 q660 q661 q662 q663 q664 q665 q666 q667 q668 q669 q670 q671 q672 q673 q674 q675 q676 q677 q678 q679 q680 q681 q682 q683 q684 q685 q686 q687 q688 q689 q690 q691 q692 q693 q694 q695 q696 q697 q698 q699 q700 q701 q702 q703 q704 q705 q706 q707 q708 q709 q710 q711 q712 q713 q714 q715 q716 q717 q718 q719 q720 q721 q722 q723 q724 q725 q726 q727 q728 q729 q730 q731 q732 q733 q734 q735 q736 q737 q738 q739 q740 q741 q742 q743 q744 q745 q746 q747 q748 q749 q750 q751 q752 q753 q754 q755 q756 q757 q758 q759 q760 q761 q762 q763 q764 q765 q766 q767 q768 q769 q770 q771 q772 q773 q774 q775 q776 q777 q778 q779 q780 q781 q782 q783 q784 q785 q786 q787 q788 q789 q790 q791 q792 q793 q794 q795 q796 q797 q798 q799 q800 q801 q802 q803 q804 q805 q806 q807 q808 q809 q810 q811 q812 q813 q814 q815 q816 q817 q818 q819 q820 q821 q822 q823 q824 q825 q826 q827 q828 q829 q830 q831 q832 q833 q834 q835 q836 q837 q838 q839 q840 q841 q842 q843 q844 q845 q846 q847 q848 q849 q850 q851 q852 q853 q854 q855 q856 q857 q858 q859 q860 q861 q862 q863 q864 q865 q866 q867 q868 q869 q870 q871 q872 q873 q874 q875 q876 q877 q878 q879 q880 q881 q882 q883 q884 q885 q886 q887 q888 q889 q890 q891 q892 q893 q894 q895 q896 q897 q898 q899 q900 q901 q902 q903 q904 q905 q906 q907 q908 q909 q910 q911 q912 q913 q914 q915 q916 q917 q918 q919 q920 q921 q922 q923 q924 q925 q926 q927 q928 q929 q930 q931 q932 q933 q934 q935 q936 q937 q938 q939 q940 q941 q942 q943 q944 q945 q946 q947 q948 q949 q950 q951 q952 q953 q954 q955 q956 q957 q958 q959 q960 q961 q962 q963 q964 q965 q966 q967 q968 q969 q970 q971 q972 q973 q974 q975 q976 q977 q978 q979 q980 q981 q982 q983 q984 q985 q986 q987 q988 q989 q990 q991 q992 q993 q994 q995 q996 q0 q1 q2 q3 q4 q5 q6 q7 q8 q9 q10 q11 q12 q13 q14 q15 q16 q17 q18 q19 q20 q21 q22 q23 q24 q25 q26 q27 q28 q29 q30 q31 q32 q33 q34 q35 q36 q37 q38 q39 q40 q41 q42 q43 q44 q45 q46 q47 q48 q49 q50 q51 q52 q53 q54 q55 q56 q57 q58 q59 q60 q61 q62 q63 q64 q65 q66 q67 q68 q69 q70 q71 q72 q73 q74 q75 q76 q77 q78 q79 q80 q81 q82 q83 q84 q85 q86 q87 q88 q89 q90 q91 q92 q93 q94 q95 q96 q97 q98 q99 q100 q101 q102 q103 q104 q105 q106 q107 q108 q109 q110 q111 q112 q113 q114 q115 q116 q117 q118 q119 q120 q121 q122 q123 q124 q125 q126 q127 q128 q129 q130 q131 q132 q133 q134 q135 q136 q137 q138 q139 q140 q141 q142 q143 q144 q145 q146 q147 q148 q149 q150 q151 q152 q153 q154 q155 q156 q157 q158 q159 q160 q161 q162 q163 q164 q165 q166 q167 q168 q169 q170 q171 q172 q173 q174 q175 q176 q177 q178 q179 q180 q181 q182 q183 q184 q185 q186 q187 q188 q189 q190 q191 q192 q193 q194 q195 q196 q197 q198 q199 q200 q201 q202 q203 q204 q205 q206 q207 q208 q209 q210 q211 q212 q213 q214 q215 q216 q217 q218 q219 q220 q221 q222 q223 q224 q225 q226 q227 q228 q229 q230 q231 q232 q233 q234 q235 q236 q237 q238 q239 q240 q241 q242 q243 q244 q245 q246 q247 q248 q249 q250 q251 q252 q253 q254 q255 q256 q257 q258 q259 q260 q261 q262 q263 q264 q265 q266 q267 q268 q269 q270 q271 q272 q273 q274 q275 q276 q277 q278 q279 q280 q281 q282 q283 q284 q285 q286 q287 q288 q289 q290 q291 q292 q293 q294 q295 q296 q297 q298 q299 q300 q301 q302 q303 q304 q305 q306 q307 q308 q309 q310 q311 q312 q313 q314 q315 q316 q317 q318 q319 q320 q321 q322 q323 q324 q325 q326 q327 q328 q329 q330 q331 q332 q333 q334 q335 q336 q337 q338 q339 q340 q341 q342 q343 q344 q345 q346 q347 q348 q349 q350 q351 q352 q353 q354 q355 q356 q357 q358 q359 q360 q361 q362 q363 q364 q365 q366 q367 q368 q369 q370 q371 q372 q373 q374 q375 q376 q377 q378 q379 q380 q381 q382 q383 q384 q385 q386 q387 q388 q389 q390 q391 q392 q393 q394 q395 q396 q397 q398 q399 q400 q401 q402 q403 q404 q405 q406 q407 q408 q409 q410 q411 q412 q413 q414 q415 q416 q417 q418 q419 q420 q421 q422 q423 q424 q425 q426 q427 q428 q429 q430 q431 q432 q433 q434 q435 q436 q437 q438 q439 q440 q441 q442 q443 q444 q445 q446 q447 q448 q449 q450 q451 q452 q453 q454 q455 q456 q457 q458 q459 q460 q461 q462 q463 q464 q465 q466 q467 q468 q469 q470 q471 q472 q473 q474 q475 q476 q477 q478 q479 q480 q481 q482 q483 q484 q485 q486 q487 q488 q489 q490 q491 q492 q493 q494 q495 q496 q497 q498 q499 q500 q501 q502 q503 q504 q505 q506 q507 q508 q509 q510 q511 q512 q513 q514 q515 q516 q517 q518 q519 q520 q521 q522 q523 q524 q525 q526 q527 q528 q529 q530 q531 q532 q533 q534 q535 q536 q537 q538 q539 q540 q541 q542 q543 q544 q545 q546 q547 q548 q549 q550 q551 q552 q553 q554 q555 q556 q557 q558 q559 q560 q561 q562 q563 q564 q565 q566 q567 q568 q569 q570 q571 q572 q573 q574 q575 q576 q577 q578 q579 q580 q581 q582 q583 q584 q585 q586 q587 q588 q589 q590 q591 q592 q593 q594 q595 q596 q597 q598 q599 q600 q601 q602 q603 q604 q605 q606 q607 q608 q609 q610 q611 q612 q613 q614 q615 q616 q617 q618 q619 q620 q621 q622 q623 q624 q625 q626 q627 q628 q629 q630 q631 q632 q633 q634 q635 q636 q637 q638 q639 q640 q641 q642 q643 q644 q645 q646 q647 q648 q649 q650 q651 q652 q653 q654 q655 q656 q657 q658 q659 q660 q661 q662 q663 q664 q665 q666 q667 q668 q669 q670 q671 q672 q673 q674 q675 q676 q677 q678 q679 q680 q681 q682 q683 q684 q685 q686 q687 q688 q689 q690 q691 q692 q693 q694 q695 q696 q697 q698 q699 q700 q701 q702 q703 q704 q705 q706 q707 q708 q709 q710 q711 q712 q713 q714 q715 q716 q717 q718 q719 q720 q721 q722 q723 q724 q725 q726 q727 q728 q729 q730 q731 q732 q733 q734 q735 q736 q737 q738 q739 q740 q741 q742 q743 q744 q745 q746 q747 q748 q749 q750 q751 q752 q753 q754 q755 q756 q757 q758 q759 q760 q761 q762 q763 q764 q765 q766 q767 q768 q769 q770 q771 q772 q773 q774 q775 q776 q777 q778 q779 q780 q781 q782 q783 q784 q785 q786 q787 q788 q789 q790 q791 q792 q793 q794 q795 q796 q797 q798 q799 q800 q801 q802 q803 q804 q805 q806 q807 q808 q809 q810 q811 q812 q813 q814 q815 q816 q817 q818 q819 q820 q821 q822 q823 q824 q825 q826 q827 q828 q829 q830 q831 q832 q833 q834 q835 q836 q837 q838 q839 q840 q841 q842 q843 q844 q845 q846 q847 q848 q849 q850 q851 q852 q853 q854 q855 q856 q857 q858 q859 q860 q861 q862 q863 q864 q865 q866 q867 q868 q869 q870 q871 q872 q873 q874 q875 q876 q877 q878 q879 q880 q881 q882 q883 q884 q885 q886 q887 q888 q889 q890 q891 q892 q893 q894 q895 q896 q897 q898 q899 q900 q901 q902 q903 q904 q905 q906 q907 q908 q909 q910 q911 q912 q913 q914 q915 q916 q917 q918 q919 q920 q921 q922 q923 q924 q925 q926 q927 q928 q929 q930 q931 q932 q933 q934 q935 q936 q937 q938 q939 q940 q941 q942 q943 q944 q945 q946 q947 q948 q949 q950 q951 q952 q953 q954 q955 q956 q957 q958 q959 q960 q961 q962 q963 q964 q965 q966 q967 q968 q969 q970 q971 q972 q973 q974 q975 q976 q977 q978 q979 q980 q981 q982 q983 q984 q985 q986 q987 q988 q989 q990 q991 q992 q993 q994 q995 q996 q0 q1 q2 q3 q4 q5\n',
        'NONE\n',
      ],
    ],
    reference:
      "import sys\nfrom collections import Counter\n\n\ndef main():\n    data = sys.stdin.read().split()\n    n = int(data[0])\n    ids = data[1:1 + n]\n    counts = Counter(ids)\n    print(next((x for x in ids if counts[x] == 1), 'NONE'))\n\n\nmain()\n",
  },
  {
    key: 'run-length-encoding',
    revision: 1,
    title: 'Compress repeated letters',
    difficulty: 'EASY',
    tags: ['strings', 'arrays'],
    companyTags: ['service-company'],
    statement: [
      'Compress a string of lower-case letters by replacing each run of the same letter with the letter followed by the length of the run. A run of length 1 is written as the letter alone.',
      'For example, `aaabccdddd` becomes `a3bc2d4`.',
      'Input: one line with the string (1 to 100 000 lower-case letters).',
      'Output: the compressed string.',
    ],
    visibleTests: [
      { input: 'aaabccdddd\n', expectedOutput: 'a3bc2d4\n', explanation: null },
      {
        input: 'abc\n',
        expectedOutput: 'abc\n',
        explanation: 'No letter repeats, so nothing changes.',
      },
    ],
    hiddenTests: [
      ['a\n', 'a\n'],
      ['zz\n', 'z2\n'],
      ['abababab\n', 'abababab\n'],
      ['aaaaaaaaaaaa\n', 'a12\n'],
      [
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab\n',
        'a100b\n',
      ],
      [
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbba\n',
        'b99a\n',
      ],
      ['abbcccddddeeeeeffffff\n', 'ab2c3d4e5f6\n'],
      [
        'aabbbabbbbbababbbbaabaaaabaababbbaabaababbabbbaaabbaaabaabbabbbbbbbabbbabbaabbbabbabbbbbbaabbabaaabaabbbaaaaaabbaaabbbaaabbbabbbaabbbabaaaaaabbbabaabbbbabaaaaaaababbbbbabaaabaaaaabaabaabbbabababaaabaabbbbbbababbabaabbbbbbaabbabaaaabaaabaaabbbaaaabbababbabbbbaababbbaaaabbbbbaaaaaaabbbbababbbaaabbabaaaabbbababaaaabaaabbaaaaaaabbbbababbabbababbaabaaababbaaabbbababbabaaabaaaaabbaaaaababaabaaabaabbbbaabababababbabbbbbbaabaaaabbbbbbabaabaabbbbbbbbbbbaaababbaabaaabaaabaabaabbaaaaaaabaabbbbabaaaabaaaabb\n',
        'a2b3ab5abab4a2ba4ba2bab3a2ba2bab2ab3a3b2a3ba2b2ab7ab3ab2a2b3ab2ab6a2b2aba3ba2b3a6b2a3b3a3b3ab3a2b3aba6b3aba2b4aba7bab5aba3ba5ba2ba2b3abababa3ba2b6abab2aba2b6a2b2aba4ba3ba3b3a4b2abab2ab4a2bab3a4b5a7b4abab3a3b2aba4b3ababa4ba3b2a7b4abab2ab2abab2a2ba3bab2a3b3abab2aba3ba5b2a5baba2ba3ba2b4a2babababab2ab6a2ba4b6aba2ba2b11a3bab2a2ba3ba3ba2ba2b2a7ba2b4aba4ba4b2\n',
      ],
      [
        'xxzzzzzzzzzzzzzzzzzzzzzzzzxxxxxxxxxxxxxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyyyyzzzzzzzzzzzxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyzzzzzzzzzzzzzzzzzzzzzzzzzzxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzzzxxxxxxxxxyyyyyyxxxzzzzzzzzzzzzzyyyyyyyyyyyyyyyyxxxxxxzzzzzzzzzzzzzzzzzyyyyyyyyyyyzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyyyyyyyyyyyyyyzzzzzzzzzzzxxyyzzzzzzzzzzzzzzzzzxzxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyzzzzzzzzzzzzzzzzzzyyyyyyyyyyyyyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyyyyyyyyyyyyyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyyyyyyyyyyyyyyyyyyyyyyzzzzzzzzzzyyyyyyyyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxyyyyyyyyyyyxxxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzzzzzzzzzzzxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyxxxxxxxxxzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxxxxxxxxxxxzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyyyyyyyyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyzzzzzxxxyyyyyyyyyyyyyyyyyyyyzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyyyyyyyyyyyyyyyyyyyyyyyyxxxxzzzzzzzzzzzzzzzzzyyyyyyyyyyyxxxxxxxxyyyyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyzzzzzzzzzzyyyyyyyyyyyyyyzzzzzzzzzzzzzyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyzzzzzzzzzzzzzzzzzzzyyyyyyyyyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxyyyyyyyyyyxxxxzzzzzzzzxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxxyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzyyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzzzzzzzxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyzzzzzzzzzzzzzzzzzzzzzzzzzxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyyyyxxxxxxxxxyyyyyyyyyyyyyyyyyzzzzzzzzzzzzzzzzzzzzzzzzzxxxxxxxyyyyyyyyyyyyyzzzzzzzzzzxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzyyyyyyyyyyyyyyyyzzzzzzzzzzzzzzzzzzzzzzzzxxxyyyyyyyyyyyyyyzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzxxxxxxxxxxxzzzzzzzzzzzzzyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxxxxyyyyyyyyxxxxxxxxxxxxxxxxxxxxzzzzzzzzzyyyyyyyyyxxxxxxxxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxyyyyyyyyyyyyyyyyyyyyyyyyyyyxxxxxxzzzzzzzzzzzzzzyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyzzzzzzzzzzzzzzzzzzzyyyyyyyyyyyyyyyyyyyyyyxxxxxxxxxxxxxxxxxxxzzzzzzzzzzzzzzzzzzzzzzzzzzyyy\n',
        'x2z24x27y25z11x8y23x29y22z26x43z16x9y6x3z13y16x6z17y11z30y14z11x2y2z17xzx53y33z18y13x30z29y13x38z42y22z10y8x30z50y33x13y11x21z24x48y53x9z50x11z37y25x15y79z5x3y20z57x55y20x23z39y24x4z17y11x8y21x30z82y48z10y14z13y66x15y46z19y9x59y10x4z8x148z41x2y33x19z14y19x28z20x11y31x29y18z25x14y25x9y17z25x7y13z10x43z54y16z24x3y14z31x11z13y70x16y8x20z9y9x22y18x41y27x6z14y36z19y22x19z26y3\n',
      ],
    ],
    reference:
      'import sys\n\n\ndef main():\n    s = sys.stdin.readline().strip()\n    parts = []\n    i = 0\n    while i < len(s):\n        j = i\n        while j < len(s) and s[j] == s[i]:\n            j += 1\n        parts.append(s[i] if j - i == 1 else f"{s[i]}{j - i}")\n        i = j\n    print("".join(parts))\n\n\nmain()\n',
  },
  {
    key: 'subarray-sum-count',
    revision: 1,
    title: 'Stretches that add up to a target',
    difficulty: 'MEDIUM',
    tags: ['hashing', 'prefix-sum', 'arrays'],
    companyTags: ['fintech', 'product-company'],
    statement: [
      'A ledger lists daily net changes (they may be negative). Count the stretches of one or more consecutive days whose changes add up to exactly `k`.',
      'Input: the first line has `n` (1 ≤ n ≤ 100 000) and `k` (|k| ≤ 10^9). The second line has `n` integers, each between -10 000 and 10 000.',
      'Output: the number of such stretches.',
      'A solution that tries every stretch is too slow for the largest inputs.',
    ],
    visibleTests: [
      {
        input: '5 3\n1 2 1 2 1\n',
        expectedOutput: '4\n',
        explanation: 'The stretches [1 2], [2 1], [1 2] and [2 1] each add up to 3.',
      },
      {
        input: '3 0\n0 0 0\n',
        expectedOutput: '6\n',
        explanation: 'Every stretch of zeros adds up to 0: there are 6.',
      },
    ],
    hiddenTests: [
      ['1 5\n5\n', '1\n'],
      ['1 5\n4\n', '0\n'],
      ['4 -2\n-1 -1 -1 -1\n', '3\n'],
      ['6 0\n1 -1 1 -1 1 -1\n', '9\n'],
      ['5 10000\n10000 -10000 10000 -10000 10000\n', '6\n'],
      ['3 7\n1 2 3\n', '0\n'],
      [
        '60 4\n0 -3 5 -3 -1 0 -3 -3 -1 2 0 -2 2 4 2 1 3 1 2 0 0 2 2 0 1 5 3 0 4 3 4 -2 4 2 4 2 4 3 -2 4 -3 0 -1 5 -1 -3 1 5 4 -1 -2 -2 3 -3 -2 4 5 1 3 5\n',
        '47\n',
      ],
      [
        '400 0\n-1 -1 2 2 0 -2 -1 0 0 -1 0 1 1 0 1 -2 0 1 -1 -2 1 1 1 -2 0 -2 0 -2 -2 1 -2 0 -1 1 2 1 1 -2 2 -2 1 -2 2 1 -1 2 1 0 -2 2 -2 -2 0 1 1 0 -2 2 0 2 1 0 2 -2 1 1 -2 0 2 1 2 -2 -1 0 -1 1 2 0 0 -1 2 0 1 0 -2 2 0 -1 0 -2 -1 2 -2 2 1 0 -1 0 -2 0 0 1 2 2 2 1 2 -2 1 2 -2 -2 -1 1 -1 -1 2 2 2 2 0 0 1 -1 2 2 -2 2 1 2 -1 0 1 2 2 1 -2 0 0 -1 0 0 -1 -2 1 2 -1 -2 -2 0 -1 -2 1 2 -1 -1 0 -1 2 -2 0 1 -1 1 -1 0 2 -1 2 -1 1 1 1 1 2 -1 1 -2 1 0 1 -1 -2 1 0 1 -1 -2 2 -2 2 1 1 -2 0 1 1 2 0 1 1 1 1 2 -2 -1 0 1 1 0 2 1 2 -2 -1 -1 -1 2 2 1 -2 1 0 0 1 0 -1 0 1 -2 0 -1 0 -1 2 0 0 -1 1 2 -1 -1 1 2 -2 -1 -1 1 1 -1 2 0 1 1 1 1 -1 0 1 0 0 1 0 0 -2 -1 1 -1 -1 2 -2 -1 2 0 0 -1 -1 1 0 1 -1 -1 1 0 -1 2 -1 2 2 2 0 2 -2 2 -2 0 -2 -1 -2 0 1 0 2 0 2 2 0 0 0 1 2 1 -2 1 2 -1 1 -2 -1 1 -1 -2 -2 2 -2 -2 1 2 2 1 0 -1 -1 2 0 -2 -1 -2 0 2 0 2 2 -2 1 2 -2 -1 -2 2 1 1 -1 -1 -1 2 2 1 -1 -1 1 0 1 -2 -2 2 -1 1 2 0 0 -2 0 -1 2 -2 -1 0 1 -1 1 0 -2 2 2 1 -1 -2 1 2 0 -1 -1 -1 -2 -2 0 0 -1 -1\n',
        '1747\n',
      ],
      [
        '900 15\n-6 8 -1 3 -6 8 5 -3 -10 -6 6 10 -9 1 3 -8 5 0 9 -5 10 1 7 -9 10 4 -9 5 0 9 9 -5 -3 2 1 4 8 2 1 2 -8 -6 -2 9 -3 9 -7 -7 -8 -4 2 -4 0 -8 3 1 -4 -9 2 -4 3 7 3 -10 8 10 -10 -10 -6 -8 -7 5 0 -5 6 3 4 7 -9 -7 -7 2 -6 -10 -6 5 -1 -1 7 -1 0 1 4 9 6 -3 -8 -6 -1 2 0 7 5 10 3 -2 6 -5 -1 4 -1 -3 -10 1 2 -3 2 1 10 -2 -8 -10 -4 -8 1 -9 -1 6 -3 -1 -10 -10 -5 -6 -6 -9 9 9 0 -4 0 -8 -2 9 10 -6 6 -9 -3 9 6 10 -10 -5 -7 9 -2 -4 -4 3 -1 -6 6 -3 -6 9 -10 0 8 6 -9 -6 -10 7 -2 -6 -8 7 0 7 8 -6 7 -4 1 -7 2 -5 -8 -9 6 8 -5 -3 -2 8 6 -5 8 10 -4 0 -5 6 -9 10 -9 3 -7 -5 2 7 8 10 9 5 -8 8 4 -3 5 0 -3 -3 2 -6 -1 -2 8 -7 -1 -2 9 7 -3 5 1 5 1 3 7 5 9 4 5 4 -4 -4 6 0 9 4 1 -2 -1 8 0 -8 1 3 3 4 -2 9 -6 10 9 4 6 -8 -6 -10 2 1 -9 4 -3 -2 7 10 5 3 -4 4 0 -3 -3 -8 -6 -4 9 0 9 0 2 -9 -5 6 5 -7 5 8 0 10 -5 4 -10 10 -10 -3 -6 -2 3 -3 9 -5 7 -2 10 7 -8 -5 -6 3 -6 -7 7 -10 2 0 9 -3 -10 -10 4 6 -9 -9 3 6 4 -6 5 1 8 -2 -1 6 -2 -8 -8 -9 -2 9 -8 10 -3 -8 7 -9 -2 -8 -10 -2 4 -5 -3 5 10 -2 10 -5 1 8 -8 2 6 -6 -3 -3 10 -5 -2 1 2 -2 8 6 -7 2 5 6 -1 -2 -8 1 -2 -7 3 10 3 -5 -4 2 8 -5 -4 -6 10 -1 0 3 -1 6 -10 4 2 -3 -2 -10 4 6 9 7 9 -10 -10 4 3 -8 5 -3 -10 -5 -9 -6 4 4 -4 -7 7 9 1 -10 5 -4 9 9 -4 -9 1 -4 3 -4 -9 -9 -3 3 -6 -6 -4 3 6 -4 7 -2 -3 9 4 6 -6 -8 -10 2 -10 -9 -2 -1 7 -4 6 -7 -8 5 0 -6 3 7 7 1 6 6 -9 -7 5 2 8 -3 -5 5 4 6 8 5 -8 -3 -6 5 4 7 -3 -4 1 -6 6 -5 0 9 6 -7 5 5 9 4 7 -3 2 6 2 5 -7 5 -1 -10 8 2 -7 0 0 2 2 -7 6 7 -9 -9 6 -10 -1 -2 10 6 3 6 -5 -4 -2 -9 -3 5 1 9 -8 10 4 -1 -10 -6 -3 -2 -6 1 -8 0 -1 -4 -4 2 -5 4 -2 -10 7 -9 9 -3 -8 10 -2 1 -7 3 -9 10 7 -1 4 -5 -2 -4 -3 1 10 7 10 -7 -2 -2 -3 6 0 9 2 3 0 -8 -1 -4 -9 0 -2 -7 10 -10 6 0 -6 -5 1 -6 -6 -10 -2 -8 -6 -7 0 -6 7 3 8 9 -1 -8 5 7 10 3 5 7 7 -9 -9 -6 -2 -6 -1 -5 7 8 10 4 5 -5 9 5 9 1 6 6 1 3 -7 -4 5 -6 -3 -6 7 -4 -9 -7 3 10 -6 0 0 9 -3 -1 -6 -10 10 -4 -1 -5 -4 -6 -3 -3 -8 5 5 4 -9 1 -6 -10 10 -2 -1 -3 7 0 -9 -4 0 4 4 -6 2 -2 8 -2 -10 0 -8 -6 -5 8 6 -2 -10 4 2 -8 -7 5 -8 -8 -10 0 -3 -7 -2 -7 -2 -2 7 -7 9 3 6 2 7 -9 -5 -2 -9 10 5 -5 1 1 2 -2 10 5 8 5 3 -7 5 6 -4 6 -7 -10 -5 5 7 -9 -2 9 8 -4 -2 5 8 2 9 -2 9 -4 3 -1 5 -3 -3 9 7 9 6 7 -4 4 -2 -9 10 10 -4 -2 -4 9 -6 -1 -7 3 10 7 -4 -2 -1 7 -2 6 -4 0 6 -8 9 -5 8 1 10 1 -4 -2 6 -7 6 3 7 8 -5 8 9 -1 -10 4 9 -3 0 -3 3 -3 1 4 -3 -2 -6 -8 -8 -9 9 1 7 1 -4 2 6 -2 -3 -2 0 6 -9 -7 5 -10 8 -4 -2 -4 -5 -1 -7 5 0 3 -4 5 -8 -9 -5 -9 -3 -10 -9 3\n',
        '2206\n',
      ],
    ],
    reference:
      'import sys\nfrom collections import defaultdict\n\n\ndef main():\n    data = sys.stdin.read().split()\n    n, k = int(data[0]), int(data[1])\n    seen = defaultdict(int)\n    seen[0] = 1\n    total = count = 0\n    for x in map(int, data[2:2 + n]):\n        total += x\n        count += seen[total - k]\n        seen[total] += 1\n    print(count)\n\n\nmain()\n',
  },
  {
    key: 'top-k-words',
    revision: 2,
    title: 'Most frequent words',
    difficulty: 'MEDIUM',
    tags: ['hashing', 'sorting', 'strings', 'heaps'],
    companyTags: ['product-company'],
    statement: [
      'Given a line of lower-case words separated by spaces, print the `k` most frequent words with their counts.',
      'Order by count (highest first), and alphabetically when counts are equal.',
      'Input: the first line has `k` (1 ≤ k ≤ the number of different words). The second line has the words (at most 100 000 of them).',
      'Output: `k` lines of `word count`.',
    ],
    visibleTests: [
      {
        input: '2\nthe cat and the hat and the bat\n',
        expectedOutput: 'the 3\nand 2\n',
        explanation: null,
      },
    ],
    hiddenTests: [
      ['1\na b c\n', 'a 1\n'],
      ['3\nx y x z y x\n', 'x 3\ny 2\nz 1\n'],
      ['2\nb a b a c\n', 'a 2\nb 2\n'],
      ['1\nsolo\n', 'solo 1\n'],
      ['1\nsame same same\n', 'same 3\n'],
      ['4\nd c b a\n', 'a 1\nb 1\nc 1\nd 1\n'],
      [
        '3\nshard index index node log queue index data log node queue queue data node node shard cache stream node data queue stream node data cache stream data index index stream node queue node shard node log api shard index log batch cache stream node stream data node api data batch shard queue index cache node node shard index index api cache index data index index data index api index stream api index data cache queue log shard data batch data log stream shard index batch api queue shard api api batch api queue data log data api data log cache node queue cache stream data queue batch queue api api cache node log log data log index index index node data data data queue log node batch log api queue api log api node api index log cache log queue cache cache log log batch queue log cache shard index cache log queue log data index node stream node api api node index queue batch index queue stream index batch cache index batch api api shard data index api index data batch shard batch cache api shard log node log api queue queue index queue data data queue shard log\n',
        'index 29\ndata 25\nlog 24\n',
      ],
      [
        '10\nstream stream queue data node data log data cache batch queue queue batch batch node batch data stream stream batch queue index stream index shard cache index cache api queue data api shard node api cache data cache stream api queue shard queue stream log api cache api index api data stream cache cache cache queue log data shard api log log node api stream log stream queue shard index shard log data shard queue api queue log log data stream queue log batch shard data batch log shard data cache log queue shard cache log data log data log index data cache data cache queue stream node stream stream log data data api batch batch data cache shard stream stream api stream batch node index cache stream log node stream stream log batch api cache stream data node node node index shard api node log node stream index data api api shard log node index node queue node data index data queue api log cache stream queue shard log stream api node data shard cache shard log stream node shard queue cache queue batch data batch api node data data batch api node queue api api index index shard data data api node log api shard log stream index log queue stream queue node cache queue cache cache log shard api cache data queue cache log api node node log shard shard log queue shard queue index data batch data shard data index batch log batch log stream api batch cache queue batch queue data cache data cache node queue shard index data index cache queue shard index log shard shard queue node log data log data queue log cache data queue stream stream cache data stream api batch queue stream queue log node data index data shard node shard shard queue queue data batch node cache node shard shard api queue api index data node queue node log batch cache node batch data shard log data queue shard api shard shard shard log batch node queue stream api queue stream stream api stream cache log batch cache batch stream cache queue stream cache queue stream index batch queue queue cache log stream node data api queue shard batch node queue data stream api data api api cache cache data log log shard node queue batch cache cache shard shard stream log stream log batch queue batch node log cache shard api log log index shard cache log queue log stream log stream cache queue log batch api stream log batch log api data batch stream queue index shard shard index api stream batch cache node api api stream shard shard stream batch node stream data queue log api node log queue batch shard api log index queue batch shard node shard batch shard index batch api queue shard data queue api stream index node batch shard cache shard stream api log shard stream index cache cache api shard batch log node stream queue data shard node stream node cache shard batch node node cache log log log data node stream node node index shard index node batch shard shard stream node data index cache index batch shard log queue data api shard index data node data index index shard log queue stream node log shard log node shard node queue api queue shard node cache api batch data log node index shard shard queue queue log cache log node api node index queue index stream data node batch queue index data batch log data stream api batch shard api queue queue log stream index index api stream index api data api shard stream shard node api index node api queue log queue cache index data data node stream data cache data cache batch api cache log log cache shard api batch batch cache api data api data stream data data index log data index shard data index queue api api batch queue data stream log node api cache stream data stream node node api stream shard data data stream batch data stream queue queue cache stream stream queue log index node batch index log node index node batch data cache queue batch shard index node node batch cache log batch api api index index log cache shard batch queue log cache api node shard cache index index data node batch shard stream cache index shard index index data queue data node node shard queue index api batch shard data batch index shard cache stream node queue api batch stream queue data index index cache shard data cache api node api index node data shard index stream node queue queue shard api shard queue data queue batch queue data stream batch log node stream stream queue queue stream queue shard stream shard index cache stream queue index batch cache cache node shard cache stream queue stream api batch log shard index shard batch stream shard log shard shard stream cache index api index index api node queue cache stream batch api node queue api index data api queue data node batch log stream cache data index stream data stream api node log stream log node data stream cache shard queue node api shard api stream log batch batch data node cache index shard stream log index log log shard shard log log cache node stream queue index queue queue node batch shard node index index api log queue node node stream index batch batch api index node shard index data batch node index log stream log api batch cache batch index api data shard queue stream index queue stream api batch data cache cache cache index log node node data api api data api data shard cache stream api index cache index cache node api data data stream log node node node node log log batch index api node data log cache stream index index data log index batch api data data cache data batch log batch data queue api index data shard node queue data index log batch cache stream cache api shard index batch log index shard api data api log node stream batch data shard queue batch data api log cache queue queue shard shard shard queue index batch stream log stream index stream index batch api api log node log node data queue batch cache api stream batch stream stream api log queue batch shard queue queue data shard queue node data cache cache stream queue data node node shard cache queue data batch index node data node index batch shard log index batch stream shard cache batch shard stream index index queue cache index index stream data log shard batch node cache cache index api queue cache node index cache log data shard cache api index api stream index data node shard cache stream cache index cache index log stream batch queue index index api queue index data data shard stream index shard index queue api batch shard api node queue stream stream log cache batch stream api stream batch batch node stream data node queue queue index stream cache shard log queue cache cache stream stream api stream index batch log batch queue queue data api batch queue node queue index node queue log node shard batch queue node index stream shard api node stream queue stream queue cache node api log stream stream stream data cache api shard cache api api data api log data log index batch batch node node stream queue shard batch node cache data data stream queue shard queue api shard index node api api shard data index shard index stream data index node batch node stream cache batch data index log index batch log index shard data data data batch shard shard shard shard stream api api node log index batch stream data data api index cache index index index queue shard log node queue log index shard shard api log data log shard queue cache stream stream log node queue index node queue shard api data node data index node stream cache index cache node index batch stream shard shard index index queue cache log data queue data stream data data shard node data data log batch batch shard stream shard batch index stream batch cache node stream log queue stream queue shard queue stream stream batch log log stream batch stream stream batch data node batch cache queue log node node stream data log shard api api queue api stream stream node api node data data stream api queue log batch api index index index batch data log api stream shard batch node data log api shard stream log queue cache shard queue shard cache batch data stream shard index index api shard queue batch stream data stream queue api index api api data api stream batch batch index api node queue api shard stream index api batch data data index cache data queue api data shard data cache index api batch log log node api cache cache api log batch cache node stream shard\n',
        'stream 167\ndata 163\nshard 159\nqueue 154\nindex 151\napi 149\nnode 149\nlog 145\nbatch 134\ncache 129\n',
      ],
      [
        '2\nzeta zeta zeta zeta zeta alpha alpha alpha alpha alpha mid mid mid mid\n',
        'alpha 5\nzeta 5\n',
      ],
    ],
    reference:
      'import sys\nfrom collections import Counter\n\n\ndef main():\n    lines = sys.stdin.read().split("\\n")\n    k = int(lines[0])\n    counts = Counter(lines[1].split())\n    for word, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:k]:\n        print(word, count)\n\n\nmain()\n',
  },
];
